const WorkflowScheduler=require('./workflow-scheduler');const AsyncWorkflowLeaseStore=require('./async-workflow-lease-store');
const { createWorkerPersistencePrincipal } = require('../security/worker-persistence-principal');
function normalizeCapabilities(value){return Array.isArray(value)?[...new Set(value.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))]:[];}
function requiredCapabilities(instance){return normalizeCapabilities(instance?.metadata?.requiredCapabilities);}
function supportsCapabilities(instance,workerCapabilities){const required=requiredCapabilities(instance);if(!required.length)return true;const available=new Set(normalizeCapabilities(workerCapabilities));return required.every(capability=>available.has(capability));}
function serializedChars(value){try{return JSON.stringify(value??null).length;}catch(error){const e=new Error('Workflow input is not serializable');e.code='WORKFLOW_INPUT_NOT_SERIALIZABLE';throw e;}}
function enforceInputQuota(instance,policy){
 if(!policy)return;
 const inputChars=serializedChars(instance?.input);
 if(Number.isFinite(policy.maxInputChars)&&inputChars>Number(policy.maxInputChars)){const e=new Error('Tenant workflow input quota exceeded');e.code='TENANT_INPUT_QUOTA_EXCEEDED';e.limit=Number(policy.maxInputChars);e.actual=inputChars;throw e;}
 if(Number.isFinite(policy.maxToolInputChars)){
  const limit=Number(policy.maxToolInputChars);
  for(const step of instance?.definition?.steps||[]){const chars=serializedChars(step.input);if(chars>limit){const e=new Error('Tenant tool input quota exceeded');e.code='TENANT_TOOL_INPUT_QUOTA_EXCEEDED';e.stepId=step.id;e.limit=limit;e.actual=chars;throw e;}}
 }
}
class AsyncWorkflowScheduler extends WorkflowScheduler{
 constructor(options={}){super({...options,leaseStore:new AsyncWorkflowLeaseStore({repository:options.leaseRepository||null,clock:options.clock,leaseDurationMs:options.leaseDurationMs,tenantId:options.tenantId})});this.async=true;this.missionEventRecovery=options.missionEventRecovery||null;this.missionEventSink=options.missionEventSink||null;this.quotaRepository=options.quotaRepository||null;this.quotaPolicy=options.quotaPolicy||null;this.workerRegistry=options.workerRegistry||options.workflowRepository?.workerRegistry||null;this.workerLeaseMs=Math.max(1000,Number(options.workerLeaseMs)||Math.max(this.leaseDurationMs*2,30000));this.dispatchWindow=Number.isInteger(options.dispatchWindow)&&options.dispatchWindow>0?options.dispatchWindow:Math.max(1,this.maxConcurrent*2);this.agingQuantumMs=Number.isInteger(options.agingQuantumMs)&&options.agingQuantumMs>0?options.agingQuantumMs:30000;}
 async cancelAsync(workflowId) {
  const queued = this.queue.find(item => item.instance.workflowId === workflowId);
  const active = this.active.get(workflowId);
  if (queued) {
    queued.instance.requestCancel();
    if (queued.instance.state !== 'CANCELLED') queued.instance.transition('CANCELLED');
    if (this.missionEventSink) {
      await this.missionEventSink.recordSnapshot(queued.instance, 'workflow_cancel_requested', { persist: false });
    }
    await this.persistAsync(queued.instance);
    this.queue = this.queue.filter(item => item.instance.workflowId !== workflowId);
    this.cancelled.add(workflowId);
    return true;
  }
  if (active) {
    active.cancelled = true;
    active.instance.requestCancel();
    if (this.missionEventSink) {
      await this.missionEventSink.recordSnapshot(active.instance, 'workflow_cancel_requested', { persist: false });
    } else {
      await this.persistAsync(active.instance);
    }
    this.cancelled.add(workflowId);
    return true;
  }
  if (this.workflowRepository?.requestCancellation) {
    const tenantId = this.tenantId || 'local';
    const snapshot = this.missionEventSink && this.workflowRepository?.findById
      ? await this.workflowRepository.findById(workflowId, tenantId)
      : null;
    if (this.missionEventSink && this.workflowRepository?.findById &&
        (!snapshot || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(snapshot.state))) return false;
    if (this.missionEventSink && snapshot) {
      const WorkflowInstance = require('./workflow-instance');
      const instance = WorkflowInstance.fromJSON(snapshot);
      instance.requestCancel();
      await this.missionEventSink.recordSnapshot(instance, 'workflow_cancel_requested', { persist: false });
    }
    const requested = await this.workflowRepository.requestCancellation(workflowId, tenantId);
    if (!requested && this.missionEventSink) {
      const latest = await this.workflowRepository.findById(workflowId, tenantId);
      if (latest) {
        const WorkflowInstance = require('./workflow-instance');
        await this.missionEventSink.recordSnapshot(
          WorkflowInstance.fromJSON(latest), 'workflow_cancel_reconciled', { persist: false }
        );
      }
    }
    if (!requested) return false;
    this.cancelled.add(workflowId);
    return true;
  }
  return false;
 }

 async recoverPersisted(workerId='worker',workerCapabilities=[],workerPrincipal=null) {
  if (!this.workflowRepository?.findAll && !this.workflowRepository?.claimQueued) return 0;
  const availableQueueCapacity = Math.max(0, this.maxQueueDepth - this.queue.length);
  if (!availableQueueCapacity || availableQueueCapacity < this.dispatchWindow) return 0;

  const tenantId = this.tenantId || 'local';
  let snapshots = null;
  let dispatchEligibleWorkflowIds = null;

  if (this.missionEventRecovery) {
    if (typeof this.workflowRepository?.findAll !== 'function') {
      throw Object.assign(
        new Error('Workflow snapshots must be enumerated before durable mission recovery can dispatch work'),
        { code: 'WORKFLOW_RECOVERY_SNAPSHOT_ENUMERATION_REQUIRED' }
      );
    }

    snapshots = await this.workflowRepository.findAll({ tenantId });
    dispatchEligibleWorkflowIds = new Set();

    for (const snapshot of snapshots) {
      if (!snapshot?.workflowId || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(snapshot.state)) continue;
      try {
        await this.missionEventRecovery.reconcile(snapshot.workflowId, tenantId);
        dispatchEligibleWorkflowIds.add(snapshot.workflowId);
      } catch (error) {
        if (
          error?.code === 'MISSION_EVENT_HISTORY_REQUIRED' ||
          error?.code === 'MISSION_EVENT_HISTORY_MISSING' ||
          error?.code === 'WORKFLOW_LEASE_HELD' ||
          error?.code === 'WORKFLOW_DISPATCH_CLAIM_HELD' ||
          error?.code === 'WORKFLOW_CHECKPOINT_CONFLICT'
        ) {
          // Legacy snapshots without an event stream retain the documented
          // pre-event recovery path. Ownership/lease conflicts remain ineligible.
          if (error?.code === 'MISSION_EVENT_HISTORY_REQUIRED') {
            dispatchEligibleWorkflowIds.add(snapshot.workflowId);
          }
          continue;
        }
        throw error;
      }
    }
  }

  const claimLimit = this.dispatchWindow;
  const usesDispatchClaims = typeof this.workflowRepository?.claimQueued === 'function';
  const persisted = usesDispatchClaims
    ? await this.workflowRepository.claimQueued({
        tenantId, workerId, limit: claimLimit,
        claimTtlMs: Math.max(this.leaseDurationMs, 5000),
        workerCapabilities, agingQuantumMs: this.agingQuantumMs, workerPrincipal
      })
    : await (snapshots || this.workflowRepository.findAll({ tenantId }));

  const releaseUnverifiedClaim = async workflowId => {
    if (!usesDispatchClaims) return;
    if (typeof this.workflowRepository.releaseDispatchClaim !== 'function') {
      throw Object.assign(
        new Error('Cannot safely release a dispatch claim for a workflow that failed recovery verification'),
        { code: 'WORKFLOW_RECOVERY_CLAIM_RELEASE_UNSUPPORTED', workflowId }
      );
    }
    try {
      await this.workflowRepository.releaseDispatchClaim(
        workflowId, workerId, tenantId, { workerPrincipal }
      );
    } catch (cause) {
      const error = Object.assign(
        new Error('Failed to release a dispatch claim for a workflow that was not recovery-verified'),
        { code: 'WORKFLOW_RECOVERY_CLAIM_RELEASE_FAILED', workflowId, cause }
      );
      throw error;
    }
  };

  const WorkflowInstance = require('./workflow-instance');
  let recovered = 0;

  for (const payload of persisted) {
    if (!payload || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(payload.state) ||
        Boolean(payload.metadata && payload.metadata.approvalBlocked)) continue;

    if (dispatchEligibleWorkflowIds && !dispatchEligibleWorkflowIds.has(payload.workflowId)) {
      await releaseUnverifiedClaim(payload.workflowId);
      continue;
    }

    if (this.queue.some(item => item.instance.workflowId === payload.workflowId) ||
        this.active.has(payload.workflowId)) continue;

    const lease = await this.leaseStore.get(payload.workflowId);
    if (lease && lease.expiresAt > this.clock()) continue;

    const instance = WorkflowInstance.fromJSON(payload);
    try {
      enforceInputQuota(instance, this.quotaPolicy);
    } catch (error) {
      instance.state = 'FAILED';
      instance.metadata = { ...instance.metadata, failureCode: error.code };
      await this.workflowRepository.save(instance);
      continue;
    }
    if (!supportsCapabilities(instance, workerCapabilities)) continue;

    if (instance.state === 'RUNNING' || instance.state === 'RECOVERING') instance.state = 'RECOVERING';
    if (instance.metadata?.fencingToken !== undefined) {
      instance.metadata = { ...instance.metadata };
      delete instance.metadata.fencingToken;
    }
    if (['CREATED', 'QUEUED', 'WAITING', 'RECOVERING'].includes(instance.state)) {
      if (this.quotaRepository) {
        if (this.quotaRepository.recoverWorkflow) {
          await this.quotaRepository.recoverWorkflow({ tenantId: this.tenantId, workflowId: instance.workflowId });
        }
        try {
          await this.quotaRepository.reserveWorkflow({
            tenantId: this.tenantId, workflowId: instance.workflowId, policy: this.quotaPolicy
          });
        } catch (error) {
          if (error?.code !== 'TENANT_QUOTA_RESERVATION_EXISTS') continue;
        }
      }
      super.enqueue(instance, { priority: Number(instance.metadata?.priority || 0), deadlineAt: instance.deadlineAt });
      await this.workflowRepository.save(instance);
      recovered++;
    }
  }
  return recovered;
 }
 async enqueueDurable(instance,options={}){enforceInputQuota(instance,this.quotaPolicy);if(!this.accepting)throw new (require('../errors/AppError'))('Workflow scheduler is shutting down',503,'SCHEDULER_SHUTTING_DOWN');if(this.quotaRepository){try{await this.quotaRepository.reserveWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,policy:this.quotaPolicy,expiresAt:options.delayMs?new Date(this.clock()+options.delayMs+this.leaseDurationMs).toISOString():null});}catch(error){if(error?.code!=='TENANT_QUOTA_RESERVATION_EXISTS')throw error;}}super.enqueue(instance,options);if(this.workflowRepository?.save)await this.workflowRepository.save(instance,this.tenantId,{workerPrincipal:options.workerPrincipal||null});return instance;}
 async leaseAsync(workerId='worker',workerCapabilities=[],workerPrincipal=null){await this.leaseStore.recoverExpired();if(this.active.size>=this.maxConcurrent)return null;this.sortQueue();const now=this.clock();const queuePassSize=this.queue.length;let inspected=0;while(this.queue.length&&inspected<queuePassSize){inspected++;const item=this.queue.shift(),instance=item.instance;if(!supportsCapabilities(instance,workerCapabilities)){this.queue.push(item);this.sortQueue();continue;}if(this.cancelled.has(instance.workflowId)||instance.cancelRequested){if(instance.state!=='CANCELLED')instance.transition('CANCELLED');await this.persistAsync(instance);continue;}if(item.availableAt>now){this.queue.unshift(item);return null;}if(item.deadlineAt&&new Date(item.deadlineAt).getTime()<=now){if(instance.state!=='FAILED')instance.transition('FAILED');instance.metadata.deadlineExceeded=true;instance.metadata.failureCode='WORKFLOW_DEADLINE_EXCEEDED';await this.persistAsync(instance);continue;}let lease;try{lease=await this.leaseStore.acquire(instance.workflowId,workerId,{tenantId:instance.tenantId,workflowId:instance.workflowId},workerPrincipal);}catch(error){if(error?.code==='WORKFLOW_LEASE_HELD'){this.queue.push(item);this.sortQueue();continue;}throw error;}if (!workerPrincipal || !Number.isSafeInteger(Number(lease.fencingToken)) || Number(lease.fencingToken) <= 0) {
 const error = Object.assign(new Error('Async worker dispatch requires a durable lease fencing token and trusted worker session'), { code: 'WORKER_DURABLE_FENCING_UNSUPPORTED', workflowId: instance.workflowId });
 try { await this.leaseStore.release(instance.workflowId, lease.leaseId, workerPrincipal); } catch (cause) { error.leaseCleanupError = cause; }
 try { if (this.workflowRepository?.releaseDispatchClaim) await this.workflowRepository.releaseDispatchClaim(instance.workflowId, workerId, this.tenantId || 'local', { workerPrincipal }); } catch (cause) { error.dispatchClaimCleanupError = cause; }
 this.queue.push(item); this.sortQueue();
 throw error;
}
const leasePrincipal = createWorkerPersistencePrincipal({
  tenantId: workerPrincipal.tenantId,
  workerId: workerPrincipal.workerId,
  sessionId: workerPrincipal.sessionId,
  capabilities: workerPrincipal.capabilities,
  workflowId: instance.workflowId,
  leaseId: lease.leaseId,
  fencingToken: lease.fencingToken
});
const previousState = instance.state;
const previousMetadata = instance.metadata;
const restoreQueuedItem = () => {
  instance.state = previousState;
  instance.metadata = previousMetadata;
  if (!this.queue.some(queued => queued.instance.workflowId === instance.workflowId)) {
    this.queue.push(item);
    this.sortQueue();
  }
};
try {
  instance.transition('RUNNING');
} catch (error) {
  try {
    await this.leaseStore.release(instance.workflowId, lease.leaseId, leasePrincipal);
  } catch (cleanupError) {
    error.cleanupError = cleanupError;
  }
  restoreQueuedItem();
  throw error;
}
instance.metadata = { ...instance.metadata, fencingToken: lease.fencingToken };
if (this.quotaRepository) {
  try {
    const reservation = await this.quotaRepository.promoteWorkflow({
      tenantId: this.tenantId,
      workflowId: instance.workflowId,
      expiresAt: lease.expiresAt,
      fencingToken: lease.fencingToken
    });
    if (!reservation) {
      await this.leaseStore.release(instance.workflowId, lease.leaseId, leasePrincipal);
      restoreQueuedItem();
      continue;
    }
  } catch (error) {
    try {
      await this.leaseStore.release(instance.workflowId, lease.leaseId, leasePrincipal);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    restoreQueuedItem();
    if (error?.code === 'TENANT_CONCURRENT_QUOTA_EXCEEDED') continue;
    throw error;
  }
}
const record = {
  workflowId: instance.workflowId,
  instance,
  leaseId: lease.leaseId,
  workerId: lease.workerId,
  workerSessionId: workerPrincipal.sessionId,
  workerPrincipal: leasePrincipal,
  fencingToken: lease.fencingToken,
  issuedAt: lease.acquiredAt,
  expiresAt: lease.expiresAt,
  deadlineAt: item.deadlineAt,
  cancelled: false,
  previousState
};
this.active.set(record.workflowId, record);
let dispatchClaimReleased = false;
try {
  if (this.workflowRepository?.releaseDispatchClaim) {
    await this.workflowRepository.releaseDispatchClaim(
      instance.workflowId, workerId, this.tenantId || 'local', { workerPrincipal }
    );
    dispatchClaimReleased = true;
  }
  await this.persistAsync(instance, leasePrincipal);
} catch (error) {
  this.active.delete(record.workflowId);
  try {
    await this.leaseStore.release(instance.workflowId, lease.leaseId, leasePrincipal);
  } catch (cleanupError) {
    error.cleanupError = cleanupError;
  }
  if (this.leaseStore.repository?.delete) {
    try {
      await this.leaseStore.repository.delete(
        instance.workflowId, lease.leaseId, this.tenantId, { workerPrincipal: leasePrincipal }
      );
    } catch (cleanupError) {
      error.cleanupLeaseRepositoryError = cleanupError;
    }
  }
  if (this.quotaRepository) {
    try {
      await this.quotaRepository.releaseWorkflow({
        tenantId: this.tenantId,
        workflowId: instance.workflowId,
        fencingToken: lease.fencingToken
      });
    } catch (cleanupError) {
      error.quotaCleanupError = cleanupError;
    }
  }
  if (!dispatchClaimReleased && this.workflowRepository?.releaseDispatchClaim) {
    try {
      await this.workflowRepository.releaseDispatchClaim(
        instance.workflowId, workerId, this.tenantId || 'local', { workerPrincipal }
      );
    } catch (cleanupError) {
      error.dispatchClaimCleanupError = cleanupError;
    }
  }
  restoreQueuedItem();
  throw error;
}
return record;}return null;}
 async assertCurrentAsync(id,leaseId,fencingToken){const active=this.active.get(id);if(!active||active.leaseId!==leaseId||Number(active.fencingToken)!==Number(fencingToken))throw Object.assign(new Error('Current workflow fencing token is invalid'),{code:'WORKFLOW_FENCING_REJECTED'});await this.leaseStore.assertCurrent(id,leaseId,fencingToken,active.workerPrincipal);return true;}
 async renewAsync(id,leaseId){const active=this.active.get(id);if(!active||active.leaseId!==leaseId)throw new Error('Active workflow lease not found');const renewed=await this.leaseStore.renew(id,leaseId,active.workerPrincipal);active.expiresAt=renewed.expiresAt;if(this.quotaRepository)await this.quotaRepository.refreshWorkflow({tenantId:this.tenantId,workflowId:id,expiresAt:renewed.expiresAt,fencingToken:active.fencingToken});return active;}
 async releaseAsync(id,leaseId=null){const active=this.active.get(id);if(!active)return false;let released;try{released=await this.leaseStore.release(id,leaseId||active.leaseId,active.workerPrincipal);}catch(error){if(['WORKER_SESSION_LOST','WORKFLOW_LEASE_NOT_OWNER','WORKFLOW_LEASE_EXPIRED','WORKFLOW_FENCING_REJECTED'].includes(error?.code)){this.active.delete(id);return false;}throw error;}if(this.quotaRepository&&released.released!==false)await this.quotaRepository.releaseWorkflow({tenantId:this.tenantId,workflowId:id,fencingToken:active.fencingToken});this.active.delete(id);return released.released!==false;}
 async persistAsync(instance,workerPrincipal=null){if(this.workflowRepository?.save){const active=this.active.get(instance.workflowId);await this.workflowRepository.save(instance,this.tenantId,{workerPrincipal:workerPrincipal||active?.workerPrincipal||null});}}
 async compensateAsync(instance,actions=[]){if(!instance||typeof instance.beginCompensation!=='function')throw new TypeError('workflow instance is required');instance.beginCompensation();for(const action of actions){if(!action?.id||typeof action.execute!=='function')continue;instance.recordCompensationAction({id:action.id,stepId:action.stepId||null,idempotencyKey:action.idempotencyKey||action.id});if(instance.compensation.completed.includes(action.id))continue;try{await action.execute();instance.markCompensationCompleted(action.id);await this.persistAsync(instance);}catch(error){instance.markCompensationFailed(action.id,error);await this.persistAsync(instance);throw error;}}return instance;}
 async retryAsync(instance,{priority=0,error,delayMs=null,workerPrincipal=null}={}){const next=instance.retry.attempt+1;if(next>this.maxRetries)return false;instance.retry.attempt=next;instance.retry.lastError={code:error?.code||'WORKFLOW_RETRY',message:error?.message||String(error)};const backoff=delayMs==null?Math.min(this.maxBackoffMs,this.baseBackoffMs*2**(next-1)):Math.max(0,delayMs);instance.retry.nextAttemptAt=new Date(this.clock()+backoff).toISOString();instance.resetStepForRetry(instance.metadata.failedStepId);if(instance.state==='RUNNING')instance.transition('WAITING');if(this.quotaRepository)await this.quotaRepository.queueWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId});await this.enqueueDurable(instance,{priority,deadlineAt:instance.deadlineAt,delayMs:backoff,workerPrincipal});return true;}
}
module.exports=AsyncWorkflowScheduler;
