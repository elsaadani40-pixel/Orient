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
  const availableQueueCapacity = Math.max(0, this.maxQueueDepth - this.queue.length - (this.pendingEnqueues?.size || 0));
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

  const releaseUnverifiedClaim = async payload => {
    if (!usesDispatchClaims) return;
    const workflowId = typeof payload === 'string' ? payload : payload?.workflowId;
    const claim = typeof payload === 'object' ? payload?.dispatchClaim : null;
    if (!claim) throw Object.assign(new Error('Exact dispatch-claim provenance is required for cleanup'), { code: 'WORKFLOW_RECOVERY_CLAIM_PROVENANCE_REQUIRED', workflowId });
    if (typeof this.workflowRepository.releaseDispatchClaim !== 'function') {
      throw Object.assign(
        new Error('Cannot safely release a dispatch claim for a workflow that failed recovery verification'),
        { code: 'WORKFLOW_RECOVERY_CLAIM_RELEASE_UNSUPPORTED', workflowId }
      );
    }
    try {
      const released = await this.workflowRepository.releaseDispatchClaim(
        workflowId, workerId, tenantId, { workerPrincipal, claim }
      );
      if (released !== true) throw Object.assign(new Error('Exact dispatch claim was not released'), { code: 'WORKFLOW_RECOVERY_CLAIM_RELEASE_NOT_OWNER', workflowId });
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
    if (!payload) continue;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(payload.state) ||
        Boolean(payload.metadata && payload.metadata.approvalBlocked)) {
      await releaseUnverifiedClaim(payload);
      continue;
    }

    if (dispatchEligibleWorkflowIds && !dispatchEligibleWorkflowIds.has(payload.workflowId)) {
      await releaseUnverifiedClaim(payload);
      continue;
    }

    if (this.queue.some(item => item.instance.workflowId === payload.workflowId) ||
        this.active.has(payload.workflowId)) {
      await releaseUnverifiedClaim(payload);
      continue;
    }

    const lease = await this.leaseStore.get(payload.workflowId);
    if (lease && lease.expiresAt > this.clock()) {
      await releaseUnverifiedClaim(payload);
      continue;
    }

    const instance = WorkflowInstance.fromJSON(payload);
    try {
      enforceInputQuota(instance, this.quotaPolicy);
    } catch (error) {
      // Do not mutate a claimed snapshot through the unleased repository path.
      // Keep the durable state unchanged until a lease-bound worker can persist
      // an authorized terminal transition.
      await releaseUnverifiedClaim(payload);
      continue;
    }
    if (!supportsCapabilities(instance, workerCapabilities)) {
      await releaseUnverifiedClaim(payload);
      continue;
    }

    if (instance.state === 'RUNNING' || instance.state === 'RECOVERING') instance.state = 'RECOVERING';
    if (instance.metadata?.fencingToken !== undefined) {
      instance.metadata = { ...instance.metadata };
      delete instance.metadata.fencingToken;
    }
    if (['CREATED', 'QUEUED', 'WAITING', 'RECOVERING'].includes(instance.state)) {
      let quotaRecoveryStarted = false;
      try {
        if (this.quotaRepository) {
          quotaRecoveryStarted = true;
          if (this.quotaRepository.recoverWorkflow) await this.quotaRepository.recoverWorkflow({ tenantId, workflowId: instance.workflowId });
          try { await this.quotaRepository.reserveWorkflow({ tenantId, workflowId: instance.workflowId, policy: this.quotaPolicy });  }
          catch (error) { if (error?.code !== 'TENANT_QUOTA_RESERVATION_EXISTS') throw error; }
        }
        if (usesDispatchClaims && !payload.dispatchClaim) throw Object.assign(new Error('Durable claim response omitted its identity'), { code: 'WORKFLOW_RECOVERY_CLAIM_PROVENANCE_REQUIRED', workflowId: instance.workflowId });
        if (instance.state !== 'QUEUED') instance.transition('QUEUED');
        super.enqueuePersisted(instance, { priority: Number(instance.metadata?.priority || 0), deadlineAt: instance.deadlineAt, dispatchClaim: payload.dispatchClaim || null });
        recovered++;
      } catch (error) {
        if (quotaRecoveryStarted && this.quotaRepository?.releaseWorkflow) { try { await this.quotaRepository.releaseWorkflow({ tenantId, workflowId: instance.workflowId }); } catch (cleanupError) { error.quotaCleanupError = cleanupError; } }
        try { await releaseUnverifiedClaim(payload); } catch (cleanupError) { error.dispatchClaimCleanupError = cleanupError; }
        throw error;
      }
    }
  }
  return recovered;
 }
 async enqueueDurable(instance,options={}){
  enforceInputQuota(instance,this.quotaPolicy);
  if(!this.accepting)throw new (require('../errors/AppError'))('Workflow scheduler is shutting down',503,'SCHEDULER_SHUTTING_DOWN');
  if(!instance)throw new TypeError('Workflow instance is required');
  const reservation=options.reservation||this.reserveEnqueue(instance);
  let quotaReserved=false;
  try{
   if(instance.state==='CREATED'||instance.state==='WAITING'||instance.state==='RECOVERING')instance.transition('QUEUED');
   else if(instance.state!=='QUEUED')throw Object.assign(new Error('Workflow is not queueable from its current state'),{code:'SCHEDULER_INVALID_STATE'});
   instance.setDeadline(options.deadlineAt??null);
   if(this.quotaRepository){
    try{await this.quotaRepository.reserveWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,policy:this.quotaPolicy,expiresAt:options.delayMs?new Date(this.clock()+options.delayMs+this.leaseDurationMs).toISOString():null});quotaReserved=true;}
    catch(error){if(error?.code!=='TENANT_QUOTA_RESERVATION_EXISTS')throw error;}
   }
   if(typeof options.beforePersist==='function')await options.beforePersist();
   else if(!options.durableAlreadyPersisted&&this.workflowRepository?.save)await this.workflowRepository.save(instance,this.tenantId,{workerPrincipal:options.workerPrincipal||null});
   this._consumeEnqueueReservation(instance,reservation);
   const now=this.clock();
   this.queue.push({instance,priority:Number(options.priority)||0,sequence:++this.sequence,enqueuedAt:now,availableAt:now+Math.max(0,Number(options.delayMs)||0),deadlineAt:options.deadlineAt||null});
   this.sortQueue();
   return instance;
  }catch(error){
   if(quotaReserved&&this.quotaRepository?.releaseWorkflow){try{await this.quotaRepository.releaseWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId});}catch(cleanupError){error.quotaCleanupError=cleanupError;}}
   this.releaseEnqueueReservation(reservation);
   throw error;
  }
 }
 async leaseAsync(workerId='worker',workerCapabilities=[],workerPrincipal=null){await this.leaseStore.recoverExpired();if(this.active.size>=this.maxConcurrent)return null;this.sortQueue();const now=this.clock();const queuePassSize=this.queue.length;let inspected=0;while(this.queue.length&&inspected<queuePassSize){inspected++;const item=this.queue.shift(),instance=item.instance;if(!supportsCapabilities(instance,workerCapabilities)){this.queue.push(item);this.sortQueue();continue;}if(this.cancelled.has(instance.workflowId)||instance.cancelRequested){if(instance.state!=='CANCELLED')instance.transition('CANCELLED');await this.persistAsync(instance);continue;}if(item.availableAt>now){this.queue.unshift(item);return null;}if(item.deadlineAt&&new Date(item.deadlineAt).getTime()<=now){if(instance.state!=='FAILED')instance.transition('FAILED');instance.metadata.deadlineExceeded=true;instance.metadata.failureCode='WORKFLOW_DEADLINE_EXCEEDED';await this.persistAsync(instance);continue;}let lease;try{lease=item.dispatchClaim ? await this.leaseStore.acquireClaimed(instance.workflowId,workerId,{tenantId:instance.tenantId,workflowId:instance.workflowId},item.dispatchClaim,workerPrincipal) : await this.leaseStore.acquire(instance.workflowId,workerId,{tenantId:instance.tenantId,workflowId:instance.workflowId},workerPrincipal);}catch(error){if(error?.code==='WORKFLOW_LEASE_HELD'){this.queue.push(item);this.sortQueue();continue;}throw error;}if (!workerPrincipal || !Number.isSafeInteger(Number(lease.fencingToken)) || Number(lease.fencingToken) <= 0) {
 const error = Object.assign(new Error('Async worker dispatch requires a durable lease fencing token and trusted worker session'), { code: 'WORKER_DURABLE_FENCING_UNSUPPORTED', workflowId: instance.workflowId });
 try { await this.leaseStore.release(instance.workflowId, lease.leaseId, workerPrincipal); } catch (cause) { error.leaseCleanupError = cause; }
 // A claimed lease has already consumed its exact claim atomically. Never
 // release an unrelated replacement claim or retry with stale provenance.
 if (!item.dispatchClaim) { this.queue.push(item); this.sortQueue(); }
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
  // A claimed item has already consumed its durable claim in the atomic handoff.
  // Do not retry it with stale provenance; durable recovery must claim it again.
  if (item.dispatchClaim) return;
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
let dispatchClaimReleased = Boolean(item.dispatchClaim);
try {
  if (!item.dispatchClaim && this.workflowRepository?.releaseDispatchClaim) {
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
      const released = await this.workflowRepository.releaseDispatchClaim(instance.workflowId, workerId, this.tenantId || 'local', { workerPrincipal, claim: item.dispatchClaim });
      if (released !== true) throw Object.assign(new Error('Exact dispatch claim cleanup failed'), { code: 'WORKFLOW_RECOVERY_CLAIM_RELEASE_NOT_OWNER' });
    } catch (cleanupError) { error.dispatchClaimCleanupError = cleanupError; }
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
