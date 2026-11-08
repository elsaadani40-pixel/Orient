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
 constructor(options={}){super({...options,leaseStore:new AsyncWorkflowLeaseStore({repository:options.leaseRepository||null,clock:options.clock,leaseDurationMs:options.leaseDurationMs,tenantId:options.tenantId})});this.async=true;this.quotaRepository=options.quotaRepository||null;this.quotaPolicy=options.quotaPolicy||null;this.workerRegistry=options.workerRegistry||options.workflowRepository?.workerRegistry||null;this.workerLeaseMs=Math.max(1000,Number(options.workerLeaseMs)||Math.max(this.leaseDurationMs*2,30000));this.dispatchClaims=new Map();this.dispatchWindow=Number.isInteger(options.dispatchWindow)&&options.dispatchWindow>0?options.dispatchWindow:Math.max(1,this.maxConcurrent*2);this.agingQuantumMs=Number.isInteger(options.agingQuantumMs)&&options.agingQuantumMs>0?options.agingQuantumMs:30000;}
 async cancelAsync(workflowId) {
  const queued = this.queue.find(item => item.instance.workflowId === workflowId);
  const active = this.active.get(workflowId);
  if (queued) {
    queued.instance.requestCancel();
    if (queued.instance.state !== 'CANCELLED') queued.instance.transition('CANCELLED');
    await this.persistAsync(queued.instance);
    const claimPrincipal=this.dispatchClaims.get(workflowId);
    if(claimPrincipal)await this.releaseDispatchClaimAsync(workflowId,claimPrincipal.workerId,claimPrincipal);
    this.queue = this.queue.filter(item => item.instance.workflowId !== workflowId);
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
 async releaseDispatchClaimAsync(workflowId,workerId,workerPrincipal=null){
  if(this.workflowRepository?.releaseDispatchClaim&&workerPrincipal){
   await this.workflowRepository.releaseDispatchClaim(workflowId,workerId,this.tenantId||'local',{workerPrincipal});
  }
  this.dispatchClaims.delete(workflowId);
 }
 async recoverPersisted(workerId='worker',workerCapabilities=[],workerPrincipal=null){
  if(!this.workflowRepository?.findAll&&!this.workflowRepository?.claimQueued)return 0;
  const availableQueueCapacity=Math.max(0,this.maxQueueDepth-this.queue.length);
  if(!availableQueueCapacity||availableQueueCapacity<this.dispatchWindow)return 0;
  const claimLimit=this.dispatchWindow;
  const hasDurableClaims=Boolean(this.workflowRepository?.claimQueued);
  const persisted=hasDurableClaims
   ? await this.workflowRepository.claimQueued({tenantId:this.tenantId||'local',workerId,limit:claimLimit,claimTtlMs:Math.max(this.leaseDurationMs,5000),workerCapabilities,agingQuantumMs:this.agingQuantumMs,workerPrincipal})
   : await this.workflowRepository.findAll({tenantId:this.tenantId});
  const WI=require('./workflow-instance');
  let recovered=0;
  for(const payload of persisted){
   const releaseClaim=async()=>{if(hasDurableClaims)await this.releaseDispatchClaimAsync(payload?.workflowId,workerId,workerPrincipal);};
   if(!payload||['COMPLETED','FAILED','CANCELLED'].includes(payload.state)||Boolean(payload.metadata&&payload.metadata.approvalBlocked)){
    await releaseClaim();continue;
   }
   if(this.queue.some(x=>x.instance.workflowId===payload.workflowId)||this.active.has(payload.workflowId)){
    await releaseClaim();continue;
   }
   const lease=await this.leaseStore.get(payload.workflowId);
   if(lease&&lease.expiresAt>this.clock()){
    await releaseClaim();continue;
   }
   const instance=WI.fromJSON(payload);
   if(instance.state==='RUNNING'||instance.state==='RECOVERING')instance.state='RECOVERING';
   if(instance.metadata?.fencingToken!==undefined){instance.metadata={...instance.metadata};delete instance.metadata.fencingToken;}
   try{enforceInputQuota(instance,this.quotaPolicy);}catch(error){
    instance.state='FAILED';instance.metadata={...instance.metadata,failureCode:error.code};
    if(hasDurableClaims)await this.workflowRepository.save(instance,this.tenantId||instance.tenantId||null,{workerPrincipal,dispatchClaim:true});
    else await this.workflowRepository.save(instance);
    await releaseClaim();continue;
   }
   if(!supportsCapabilities(instance,workerCapabilities)){
    await releaseClaim();continue;
   }
   if(!['CREATED','QUEUED','WAITING','RECOVERING'].includes(instance.state)){
    await releaseClaim();continue;
   }
   if(this.quotaRepository){
    if(this.quotaRepository.recoverWorkflow)await this.quotaRepository.recoverWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId});
    try{await this.quotaRepository.reserveWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,policy:this.quotaPolicy});}
    catch(error){if(error?.code!=='TENANT_QUOTA_RESERVATION_EXISTS'){await releaseClaim();continue;}}
   }
   super.enqueue(instance,{priority:Number(instance.metadata?.priority||0),deadlineAt:instance.deadlineAt});
   try{
    if(hasDurableClaims)await this.workflowRepository.save(instance,this.tenantId||instance.tenantId||null,{workerPrincipal,dispatchClaim:true});
    else await this.workflowRepository.save(instance);
   }catch(error){
    this.queue=this.queue.filter(item=>item.instance.workflowId!==instance.workflowId);
    await releaseClaim();throw error;
   }
   if(hasDurableClaims)this.dispatchClaims.set(instance.workflowId,workerPrincipal);
   recovered++;
  }
  return recovered;
 }
 async enqueueDurable(instance,options={}){enforceInputQuota(instance,this.quotaPolicy);if(!this.accepting)throw new (require('../errors/AppError'))('Workflow scheduler is shutting down',503,'SCHEDULER_SHUTTING_DOWN');if(this.quotaRepository){try{await this.quotaRepository.reserveWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,policy:this.quotaPolicy,expiresAt:options.delayMs?new Date(this.clock()+options.delayMs+this.leaseDurationMs).toISOString():null});}catch(error){if(error?.code!=='TENANT_QUOTA_RESERVATION_EXISTS')throw error;}}super.enqueue(instance,options);await this.persistAsync(instance);return instance;}
 async leaseAsync(workerId='worker',workerCapabilities=[],workerPrincipal=null){await this.leaseStore.recoverExpired();if(this.active.size>=this.maxConcurrent)return null;this.sortQueue();const now=this.clock();const queuePassSize=this.queue.length;let inspected=0;while(this.queue.length&&inspected<queuePassSize){inspected++;const item=this.queue.shift(),instance=item.instance;if(!supportsCapabilities(instance,workerCapabilities)){this.queue.push(item);this.sortQueue();continue;}if(this.cancelled.has(instance.workflowId)||instance.cancelRequested){if(instance.state!=='CANCELLED')instance.transition('CANCELLED');await this.persistAsync(instance);const claimPrincipal=this.dispatchClaims.get(instance.workflowId);if(claimPrincipal)await this.releaseDispatchClaimAsync(instance.workflowId,claimPrincipal.workerId,claimPrincipal);continue;}if(item.availableAt>now){this.queue.unshift(item);return null;}if(item.deadlineAt&&new Date(item.deadlineAt).getTime()<=now){if(instance.state!=='FAILED')instance.transition('FAILED');instance.metadata.deadlineExceeded=true;instance.metadata.failureCode='WORKFLOW_DEADLINE_EXCEEDED';await this.persistAsync(instance);const claimPrincipal=this.dispatchClaims.get(instance.workflowId);if(claimPrincipal)await this.releaseDispatchClaimAsync(instance.workflowId,claimPrincipal.workerId,claimPrincipal);continue;}let lease;try{lease=await this.leaseStore.acquire(instance.workflowId,workerId,{tenantId:instance.tenantId,workflowId:instance.workflowId},workerPrincipal);}catch(error){if(error?.code==='WORKFLOW_LEASE_HELD'){this.queue.push(item);this.sortQueue();continue;}throw error;}const leasePrincipal = workerPrincipal && Number.isSafeInteger(Number(lease.fencingToken)) && Number(lease.fencingToken) > 0 ? createWorkerPersistencePrincipal({tenantId:workerPrincipal.tenantId,workerId:workerPrincipal.workerId,sessionId:workerPrincipal.sessionId,capabilities:workerPrincipal.capabilities,workflowId:instance.workflowId,leaseId:lease.leaseId,fencingToken:lease.fencingToken}) : null;const previousState=instance.state;try{instance.transition('RUNNING');}catch(error){await this.leaseStore.release(instance.workflowId,lease.leaseId,leasePrincipal);throw error;}instance.metadata = {...instance.metadata, fencingToken: lease.fencingToken}; if(this.quotaRepository){try{const reservation=await this.quotaRepository.promoteWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,expiresAt:lease.expiresAt,fencingToken:lease.fencingToken});if(!reservation){await this.leaseStore.release(instance.workflowId,lease.leaseId,leasePrincipal);this.queue.push(item);this.sortQueue();continue;}}catch(error){await this.leaseStore.release(instance.workflowId,lease.leaseId,leasePrincipal);if(error?.code==='TENANT_CONCURRENT_QUOTA_EXCEEDED'){this.queue.push(item);this.sortQueue();continue;}throw error;}} const record={workflowId:instance.workflowId,instance,leaseId:lease.leaseId,workerId:lease.workerId,workerSessionId:workerPrincipal?.sessionId||null,workerPrincipal:leasePrincipal,fencingToken:lease.fencingToken,issuedAt:lease.acquiredAt,expiresAt:lease.expiresAt,deadlineAt:item.deadlineAt,cancelled:false,previousState};this.active.set(record.workflowId,record);if(this.dispatchClaims.has(instance.workflowId))await this.releaseDispatchClaimAsync(instance.workflowId,workerId,workerPrincipal);else if(this.workflowRepository?.releaseDispatchClaim)await this.workflowRepository.releaseDispatchClaim(instance.workflowId,workerId,this.tenantId||'local',{workerPrincipal});try{await this.persistAsync(instance,leasePrincipal);}catch(error){this.active.delete(record.workflowId);try{await this.leaseStore.release(instance.workflowId,lease.leaseId,leasePrincipal);}catch(cleanupError){error.cleanupError=cleanupError;}if(this.leaseStore.repository?.delete){try{await this.leaseStore.repository.delete(instance.workflowId,lease.leaseId,this.tenantId,{workerPrincipal:leasePrincipal});}catch(cleanupError){error.cleanupLeaseRepositoryError=cleanupError;}}if(this.quotaRepository){try{await this.quotaRepository.releaseWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId,fencingToken:lease.fencingToken});}catch(cleanupError){error.quotaCleanupError=cleanupError;}}throw error;}return record;}return null;}
 async assertCurrentAsync(id,leaseId,fencingToken){const active=this.active.get(id);if(!active||active.leaseId!==leaseId||Number(active.fencingToken)!==Number(fencingToken))throw Object.assign(new Error('Current workflow fencing token is invalid'),{code:'WORKFLOW_FENCING_REJECTED'});await this.leaseStore.assertCurrent(id,leaseId,fencingToken,active.workerPrincipal);return true;}
 async renewAsync(id,leaseId){const active=this.active.get(id);if(!active||active.leaseId!==leaseId)throw new Error('Active workflow lease not found');const renewed=await this.leaseStore.renew(id,leaseId,active.workerPrincipal);active.expiresAt=renewed.expiresAt;if(this.quotaRepository)await this.quotaRepository.refreshWorkflow({tenantId:this.tenantId,workflowId:id,expiresAt:renewed.expiresAt,fencingToken:active.fencingToken});return active;}
 async clearReleasedFencingMetadata(active){
  // Clear only the local object after confirmed release. Durable stale tokens
  // are cleared by the next worker's claimed recovery before it requeues work.
  if(active?.instance?.metadata&&Number(active.instance.metadata.fencingToken)===Number(active.fencingToken)){
   delete active.instance.metadata.fencingToken;
  }
 }
 async releaseAsync(id,leaseId=null){
  const active=this.active.get(id);if(!active)return false;
  let released;
  try{released=await this.leaseStore.release(id,leaseId||active.leaseId,active.workerPrincipal);}
  catch(error){
   if(['WORKER_SESSION_LOST','WORKFLOW_LEASE_NOT_OWNER','WORKFLOW_LEASE_EXPIRED','WORKFLOW_FENCING_REJECTED'].includes(error?.code)){
    this.active.delete(id);return false;
   }
   throw error;
  }
  if(released.released===false){this.active.delete(id);return false;}
  if(this.quotaRepository)await this.quotaRepository.releaseWorkflow({tenantId:this.tenantId,workflowId:id,fencingToken:active.fencingToken});
  this.active.delete(id);this.clearReleasedFencingMetadata(active);return true;
 }
 persist(instance){
  // WorkflowScheduler.enqueue() invokes persistence synchronously. The async
  // scheduler persists explicitly after acquiring the correct dispatch/lease authority.
  return instance;
 }
 async persistAsync(instance,workerPrincipal=null){if(this.workflowRepository?.save){const active=this.active.get(instance.workflowId);const dispatchPrincipal=!active?this.dispatchClaims.get(instance.workflowId):null;const principal=workerPrincipal||active?.workerPrincipal||dispatchPrincipal||null;await this.workflowRepository.save(instance,this.tenantId||instance.tenantId||null,{workerPrincipal:principal,dispatchClaim:Boolean(dispatchPrincipal)});}}
 async compensateAsync(instance,actions=[]){if(!instance||typeof instance.beginCompensation!=='function')throw new TypeError('workflow instance is required');instance.beginCompensation();for(const action of actions){if(!action?.id||typeof action.execute!=='function')continue;instance.recordCompensationAction({id:action.id,stepId:action.stepId||null,idempotencyKey:action.idempotencyKey||action.id});if(instance.compensation.completed.includes(action.id))continue;try{await action.execute();instance.markCompensationCompleted(action.id);await this.persistAsync(instance);}catch(error){instance.markCompensationFailed(action.id,error);await this.persistAsync(instance);throw error;}}return instance;}
 async retryAsync(instance,{priority=0,error,delayMs=null}={}){const next=instance.retry.attempt+1;if(next>this.maxRetries)return false;instance.retry.attempt=next;instance.retry.lastError={code:error?.code||'WORKFLOW_RETRY',message:error?.message||String(error)};const backoff=delayMs==null?Math.min(this.maxBackoffMs,this.baseBackoffMs*2**(next-1)):Math.max(0,delayMs);instance.retry.nextAttemptAt=new Date(this.clock()+backoff).toISOString();instance.resetStepForRetry(instance.metadata.failedStepId);if(instance.state==='RUNNING')instance.transition('WAITING');if(this.quotaRepository)await this.quotaRepository.queueWorkflow({tenantId:this.tenantId,workflowId:instance.workflowId});await this.enqueueDurable(instance,{priority,deadlineAt:instance.deadlineAt,delayMs:backoff});return true;}
}
module.exports=AsyncWorkflowScheduler;
