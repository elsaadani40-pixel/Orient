const WorkflowScheduler=require('./workflow-scheduler');const AsyncWorkflowLeaseStore=require('./async-workflow-lease-store');
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
 constructor(options={}){super({...options,leaseStore:new AsyncWorkflowLeaseStore({repository:options.leaseRepository||null,clock:options.clock,leaseDurationMs:options.leaseDurationMs,tenantId:options.tenantId})});this.async=true;this.leaseDurationMs=Number.isFinite(Number(options.leaseDurationMs))&&Number(options.leaseDurationMs)>0?Number(options.leaseDurationMs):30000;this.quotaRepository=options.quotaRepository||null;this.quotaPolicy=options.quotaPolicy||null;this.workerRegistry=options.workerRegistry||options.workflowRepository?.workerRegistry||null;this.recoveryWorkerId=options.workerId||('orient-recovery-'+require('node:crypto').randomUUID());this.workerLeaseMs=Math.max(1000,Number(options.workerLeaseMs)||Math.max(this.leaseDurationMs*2,30000));this.dispatchWindow=Number.isInteger(options.dispatchWindow)&&options.dispatchWindow>0?options.dispatchWindow:Math.max(1,this.maxConcurrent*2);this.agingQuantumMs=Number.isInteger(options.agingQuantumMs)&&options.agingQuantumMs>0?options.agingQuantumMs:30000;this.pendingDurableItems=new WeakSet();}
 async releaseDispatchClaimByWorkflowId(workflowId, workerId) {
  if (!workflowId || !workerId || !this.workflowRepository?.releaseDispatchClaim) return false;
  return this.workflowRepository.releaseDispatchClaim(workflowId, workerId, this.tenantId || 'local');
 }
 async releaseDispatchClaim(item) {
  if (!item?.dispatchClaimWorkerId) return false;
  const released = await this.releaseDispatchClaimByWorkflowId(item.instance.workflowId, item.dispatchClaimWorkerId);
  item.dispatchClaimWorkerId = null;
  return released;
 }
 async releaseQueuedQuota(instance) {
  if (!instance || !this.quotaRepository?.releaseWorkflow) return false;
  return this.quotaRepository.releaseWorkflow({
   tenantId: this.tenantId || instance.tenantId || 'local',
   workflowId: instance.workflowId
  });
 }
 async cancelAsync(workflowId) {
  const queued = this.queue.find(item => item.instance.workflowId === workflowId);
  const active = this.active.get(workflowId);
  if (queued) {
    queued.instance.requestCancel();
    if (queued.instance.state !== 'CANCELLED') queued.instance.transition('CANCELLED');
    try {
      await this.persistAsync(queued.instance);
      await this.releaseQueuedQuota(queued.instance);
    } finally {
      this.queue = this.queue.filter(item => item.instance.workflowId !== workflowId);
      await this.releaseDispatchClaim(queued);
    }
    this.cancelled.add(workflowId);
    return true;
  }
  if (active) {
    active.cancelled = true;
    active.instance.requestCancel();
    await this.persistAsync(active.instance);
    this.cancelled.add(workflowId);
    return true;
  }
  if (this.workflowRepository?.requestCancellation) {
    const requested = await this.workflowRepository.requestCancellation(workflowId, this.tenantId || 'local');
    if (!requested) return false;
    this.cancelled.add(workflowId);
    return true;
  }
  return false;
 }
 async recoverPersisted(workerId=this.recoveryWorkerId,workerCapabilities=[]){if(!this.workflowRepository?.findAll&&!this.workflowRepository?.claimQueued)return 0;if(this.workflowRepository?.claimQueued&&this.workerRegistry?.register){const clockValue=this.clock();const now=clockValue instanceof Date?clockValue.getTime():Number(clockValue);if(!Number.isFinite(now))throw Object.assign(new Error('Workflow recovery clock returned an invalid time'),{code:'WORKFLOW_RECOVERY_CLOCK_INVALID'});const nowIso=new Date(now).toISOString();await this.workerRegistry.register({workerId,tenantId:this.tenantId||'local',startedAt:nowIso,heartbeatAt:nowIso,expiresAt:new Date(now+Math.max(this.workerLeaseMs,this.leaseDurationMs*2)).toISOString(),status:'READY',capabilities:workerCapabilities},this.tenantId||'local');}const availableQueueCapacity=Math.max(0,this.maxQueueDepth-this.queue.length);if(!availableQueueCapacity||availableQueueCapacity<this.dispatchWindow)return 0;const claimLimit=this.dispatchWindow;let recovered=0;const persisted=this.workflowRepository?.claimQueued?await this.workflowRepository.claimQueued({tenantId:this.tenantId||'local',workerId,limit:claimLimit,claimTtlMs:Math.max(this.leaseDurationMs,5000),workerCapabilities,agingQuantumMs:this.agingQuantumMs}):await this.workflowRepository.findAll({tenantId:this.tenantId});const WI=require('./workflow-instance');for(const payload of persisted){if(!payload)continue;if(['COMPLETED','FAILED','CANCELLED'].includes(payload.state)){await this.releaseQueuedQuota({workflowId:payload.workflowId,tenantId:payload.tenantId});await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);continue;}if(Boolean(payload.metadata&&payload.metadata.approvalBlocked)){await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);continue;}if(this.queue.some(x=>x.instance.workflowId===payload.workflowId)||this.active.has(payload.workflowId)){await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);continue;}let lease;try{lease=await this.leaseStore.get(payload.workflowId);}catch(error){try{await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);}catch(cleanupError){error.dispatchClaimCleanupError=cleanupError;}throw error;}if(lease&&lease.expiresAt>this.clock()){await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);continue;}let instance;try{instance=WI.fromJSON(payload);}catch(error){try{await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);}catch(cleanupError){error.dispatchClaimCleanupError=cleanupError;}throw error;}try{enforceInputQuota(instance,this.quotaPolicy);}catch(error){instance.state='FAILED';instance.metadata={...instance.metadata,failureCode:error.code};try{await this.workflowRepository.save(instance);}catch(saveError){try{await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);}catch(cleanupError){saveError.dispatchClaimCleanupError=cleanupError;}throw saveError;}await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);continue;}let capabilitySupported;try{capabilitySupported=supportsCapabilities(instance,workerCapabilities);}catch(error){try{await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);}catch(cleanupError){error.dispatchClaimCleanupError=cleanupError;}throw error;}if(!capabilitySupported){await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);continue;}if(instance.state==='RUNNING'||instance.state==='RECOVERING')instance.state='RECOVERING';if(instance.metadata?.fencingToken!==undefined){instance.metadata={...instance.metadata};delete instance.metadata.fencingToken;}if(['CREATED','QUEUED','WAITING','RECOVERING'].includes(instance.state)){let recoveryReservationCreated=false;let recoveryReservationReservedAt=null;if(this.quotaRepository){if(this.quotaRepository.recoverWorkflow){try{await this.quotaRepository.recoverWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId});}catch(error){try{await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);}catch(cleanupError){error.dispatchClaimCleanupError=cleanupError;}throw error;}}try{const reservation=await this.quotaRepository.reserveWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,policy:this.quotaPolicy});recoveryReservationCreated=reservation?.created!==false;recoveryReservationReservedAt=reservation?.reservedAt||null;}catch(error){if(error?.code!=='TENANT_QUOTA_RESERVATION_EXISTS'){await this.releaseDispatchClaimByWorkflowId(payload.workflowId,workerId);continue;}}}super.enqueue(instance,{priority:Number(instance.metadata?.priority||0),deadlineAt:instance.deadlineAt});const queuedItem=this.queue.find(item=>item.instance.workflowId===instance.workflowId);if(queuedItem&&this.workflowRepository?.claimQueued)queuedItem.dispatchClaimWorkerId=workerId;try{await this.workflowRepository.save(instance);recovered++;}catch(error){this.queue=this.queue.filter(item=>item!==queuedItem);try{await this.releaseDispatchClaim(queuedItem);}catch(cleanupError){error.dispatchClaimCleanupError=cleanupError;}if(recoveryReservationCreated&&this.quotaRepository){try{await this.quotaRepository.releaseWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,reservedAt:recoveryReservationReservedAt});}catch(cleanupError){error.quotaCleanupError=cleanupError;}}throw error;}}}return recovered;}
 async enqueueDurable(instance,options={}){
  enforceInputQuota(instance,this.quotaPolicy);
  if(!this.accepting)throw new (require('../errors/AppError'))('Workflow scheduler is shutting down',503,'SCHEDULER_SHUTTING_DOWN');
  let reservationCreated=false;
  let reservationReservedAt=null;
  if(this.quotaRepository){
   try{
    const reservation=await this.quotaRepository.reserveWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,policy:this.quotaPolicy,expiresAt:null});
    reservationCreated=reservation?.created!==false;
    reservationReservedAt=reservation?.reservedAt||null;
   }catch(error){
    if(error?.code!=='TENANT_QUOTA_RESERVATION_EXISTS')throw error;
   }
  }
  const previousState=instance.state;
  const previousUpdatedAt=instance.updatedAt;
  const previousDeadlineAt=instance.deadlineAt;
  const previousQueueItems=new Set(this.queue);
  let queuedItem=null;
  try{
   super.enqueue(instance,options);
   queuedItem=this.queue.find(item=>!previousQueueItems.has(item)&&item.instance===instance);
   if(!queuedItem)throw new Error('Workflow queue admission did not produce a queue item');
   // Keep the item invisible to workers until its durable write has committed.
   this.pendingDurableItems.add(queuedItem);
   await this.persistAsync(instance);
   this.pendingDurableItems.delete(queuedItem);
   return instance;
  }catch(error){
   if(queuedItem){
    this.pendingDurableItems.delete(queuedItem);
    this.queue=this.queue.filter(item=>item!==queuedItem);
   }
   instance.state=previousState;
   instance.updatedAt=previousUpdatedAt;
   instance.deadlineAt=previousDeadlineAt;
   if(reservationCreated&&this.quotaRepository){
    try{await this.quotaRepository.releaseWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,reservedAt:reservationReservedAt});}
    catch(cleanupError){error.quotaCleanupError=cleanupError;}
   }
   throw error;
  }
 }
 async leaseAsync(workerId='worker',workerCapabilities=[]){await this.leaseStore.recoverExpired();if(this.active.size>=this.maxConcurrent)return null;this.sortQueue();const now=this.clock();const queuePassSize=this.queue.length;let inspected=0;while(this.queue.length&&inspected<queuePassSize){inspected++;const item=this.queue.shift(),instance=item.instance;if(this.pendingDurableItems.has(item)){this.queue.push(item);this.sortQueue();continue;}if(!supportsCapabilities(instance,workerCapabilities)){this.queue.push(item);this.sortQueue();continue;}if(this.cancelled.has(instance.workflowId)||instance.cancelRequested){if(instance.state!=='CANCELLED')instance.transition('CANCELLED');try{await this.persistAsync(instance);await this.releaseQueuedQuota(instance);}finally{await this.releaseDispatchClaim(item);}continue;}if(item.availableAt>now){this.queue.unshift(item);return null;}if(item.deadlineAt&&new Date(item.deadlineAt).getTime()<=now){if(instance.state!=='FAILED')instance.transition('FAILED');instance.metadata.deadlineExceeded=true;instance.metadata.failureCode='WORKFLOW_DEADLINE_EXCEEDED';try{await this.persistAsync(instance);await this.releaseQueuedQuota(instance);}finally{await this.releaseDispatchClaim(item);}continue;}let lease;try{lease=await this.leaseStore.acquire(instance.workflowId,workerId,{tenantId:instance.tenantId,workflowId:instance.workflowId});}catch(error){if(error?.code==='WORKFLOW_LEASE_HELD'){this.queue.push(item);this.sortQueue();continue;}throw error;}const previousState=instance.state;const previousUpdatedAt=instance.updatedAt;const previousMetadata=instance.metadata;try{instance.transition('RUNNING');}catch(error){await this.leaseStore.release(instance.workflowId,lease.leaseId);throw error;}instance.metadata = {...instance.metadata, fencingToken: lease.fencingToken}; if(this.quotaRepository){try{const reservation=await this.quotaRepository.promoteWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,expiresAt:lease.expiresAt,fencingToken:lease.fencingToken});if(!reservation){await this.leaseStore.release(instance.workflowId,lease.leaseId);instance.state=previousState;instance.updatedAt=previousUpdatedAt;instance.metadata=previousMetadata;this.queue.push(item);this.sortQueue();continue;}}catch(error){await this.leaseStore.release(instance.workflowId,lease.leaseId);if(error?.code==='TENANT_CONCURRENT_QUOTA_EXCEEDED'){instance.state=previousState;instance.updatedAt=previousUpdatedAt;instance.metadata=previousMetadata;this.queue.push(item);this.sortQueue();continue;}throw error;}} const record={workflowId:instance.workflowId,instance,leaseId:lease.leaseId,workerId:lease.workerId,fencingToken:lease.fencingToken,issuedAt:lease.acquiredAt,expiresAt:lease.expiresAt,deadlineAt:item.deadlineAt,cancelled:false,previousState};this.active.set(record.workflowId,record);try{if(this.workflowRepository?.releaseDispatchClaim){await this.workflowRepository.releaseDispatchClaim(instance.workflowId,item.dispatchClaimWorkerId||workerId,this.tenantId||'local');item.dispatchClaimWorkerId=null;}await this.persistAsync(instance);}catch(error){this.active.delete(record.workflowId);try{await this.leaseStore.release(instance.workflowId,lease.leaseId);}catch(cleanupError){error.cleanupError=cleanupError;}if(this.leaseStore.repository?.delete){try{await this.leaseStore.repository.delete(instance.workflowId,lease.leaseId,this.tenantId);}catch(cleanupError){error.cleanupLeaseRepositoryError=cleanupError;}}if(this.quotaRepository){try{await this.quotaRepository.releaseWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,fencingToken:lease.fencingToken});}catch(cleanupError){error.quotaCleanupError=cleanupError;}}if(item.dispatchClaimWorkerId){try{await this.releaseDispatchClaim(item);}catch(cleanupError){error.dispatchClaimCleanupError=cleanupError;}}throw error;}return record;}return null;}
 async assertCurrentAsync(id,leaseId,fencingToken){const active=this.active.get(id);if(!active||active.leaseId!==leaseId||Number(active.fencingToken)!==Number(fencingToken))throw Object.assign(new Error('Current workflow fencing token is invalid'),{code:'WORKFLOW_FENCING_REJECTED'});await this.leaseStore.assertCurrent(id,leaseId,fencingToken);return true;}
 async renewAsync(id,leaseId){const active=this.active.get(id);if(!active||active.leaseId!==leaseId)throw new Error('Active workflow lease not found');const renewed=await this.leaseStore.renew(id,leaseId);active.expiresAt=renewed.expiresAt;if(this.quotaRepository)await this.quotaRepository.refreshWorkflow({tenantId:this.tenantId,workflowId:id,expiresAt:renewed.expiresAt,fencingToken:active.fencingToken});return active;}
 async releaseAsync(id,leaseId=null){const active=this.active.get(id);if(!active)return false;const released=await this.leaseStore.release(id,leaseId||active.leaseId);if(this.quotaRepository&&released.released!==false)await this.quotaRepository.releaseWorkflow({tenantId:this.tenantId,workflowId:id,fencingToken:active.fencingToken});this.active.delete(id);return released.released!==false;}
 persist(instance){/* Async scheduler writes must be awaited by its explicit async paths. */}
 async shutdown({cancelQueued=false}={}){this.accepting=false;if(cancelQueued){for(const item of this.queue){if(item.instance.state!=='CANCELLED'){item.instance.requestCancel();item.instance.transition('CANCELLED');}try{await this.persistAsync(item.instance);await this.releaseQueuedQuota(item.instance);}finally{await this.releaseDispatchClaim(item);}}this.queue=[];}return this.snapshot();}
 async persistAsync(instance){if(this.workflowRepository?.save)await this.workflowRepository.save(instance);}
 async compensateAsync(instance,actions=[]){if(!instance||typeof instance.beginCompensation!=='function')throw new TypeError('workflow instance is required');instance.beginCompensation();for(const action of actions){if(!action?.id||typeof action.execute!=='function')continue;instance.recordCompensationAction({id:action.id,stepId:action.stepId||null,idempotencyKey:action.idempotencyKey||action.id});if(instance.compensation.completed.includes(action.id))continue;try{await action.execute();instance.markCompensationCompleted(action.id);await this.persistAsync(instance);}catch(error){instance.markCompensationFailed(action.id,error);await this.persistAsync(instance);throw error;}}return instance;}
 async retryAsync(instance,{priority=0,error,delayMs=null}={}){const next=instance.retry.attempt+1;if(next>this.maxRetries)return false;instance.retry.attempt=next;instance.retry.lastError={code:error?.code||'WORKFLOW_RETRY',message:error?.message||String(error)};const backoff=delayMs==null?Math.min(this.maxBackoffMs,this.baseBackoffMs*2**(next-1)):Math.max(0,delayMs);instance.retry.nextAttemptAt=new Date(this.clock()+backoff).toISOString();instance.resetStepForRetry(instance.metadata.failedStepId);if(instance.state==='RUNNING')instance.transition('WAITING');if(this.quotaRepository)await this.quotaRepository.queueWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId});await this.enqueueDurable(instance,{priority,deadlineAt:instance.deadlineAt,delayMs:backoff});return true;}
}
module.exports=AsyncWorkflowScheduler;
