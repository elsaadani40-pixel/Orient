const crypto=require('crypto');const WorkflowDefinition=require('./workflow-definition');const {createWorkerPersistencePrincipal,assertWorkerPersistencePrincipal}=require('../security/worker-persistence-principal');
function isLeaseLost(error){return ['WORKER_SESSION_LOST','WORKFLOW_LEASE_NOT_OWNER','WORKFLOW_LEASE_EXPIRED','WORKFLOW_FENCING_REJECTED'].includes(error?.code);}
class AsyncWorkflowWorker{
 constructor({scheduler,executor,eventSink=()=>{},workerId=crypto.randomUUID(),now=()=>Date.now(),retryClassifier=()=>true,capabilities=[],workerRegistry=null,workerLeaseMs=30000,tenantId=null,workerPrincipal=null,persistAfterTick=true}){
  this.scheduler=scheduler;this.executor=executor;this.eventSink=eventSink;this.workerId=workerId;this.now=now;this.retryClassifier=retryClassifier;this.workerRegistry=workerRegistry;this.workerLeaseMs=Math.max(1000,Number(workerLeaseMs)||30000);this.tenantId=tenantId||scheduler?.tenantId||null;this.capabilities=Array.isArray(capabilities)?[...new Set(capabilities.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))]:[];this.persistAfterTick=persistAfterTick!==false;this.workerPrincipal=workerPrincipal?assertWorkerPersistencePrincipal(workerPrincipal):createWorkerPersistencePrincipal({tenantId:this.tenantId||'local',workerId:this.workerId,sessionId:crypto.randomUUID(),capabilities:this.capabilities});if(this.workerPrincipal.tenantId!==(this.tenantId||'local')||this.workerPrincipal.workerId!==this.workerId||this.capabilities.some(capability=>!this.workerPrincipal.capabilities.includes(capability)))throw Object.assign(new Error('Worker principal does not match worker identity or capabilities'),{code:'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH'});
 }
 async tick(){
  if(this.workerRegistry?.register){
   await this.workerRegistry.register({workerId:this.workerId,tenantId:this.tenantId,heartbeatAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+this.workerLeaseMs).toISOString(),status:'READY',capabilities:this.capabilities,metadata:{workerRuntime:'orient-one'}},this.tenantId,{workerPrincipal:this.workerPrincipal});
  }
  const lease=await this.scheduler.leaseAsync(this.workerId,this.capabilities||[],this.workerPrincipal);if(!lease)return null;
  const instance=lease.instance;this.currentWorkerPrincipal=lease.workerPrincipal||this.workerPrincipal;let leaseLost=false;let workerHeartbeatError=null;let workerHeartbeat=null;
  const startWorkerHeartbeat=()=>{
   if(!this.workerRegistry?.heartbeat)return;
   const heartbeatMs=Math.max(1000,Math.floor(this.workerLeaseMs/3));
   workerHeartbeat=setInterval(()=>{this.workerRegistry.heartbeat(this.workerId,{tenantId:this.tenantId,heartbeatAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+this.workerLeaseMs).toISOString(),status:'READY',workerPrincipal:this.workerPrincipal}).catch(error=>{workerHeartbeatError=error;this.emit('worker.heartbeat.failed',{workerId:this.workerId,error:{code:error?.code||'WORKER_HEARTBEAT_FAILED',message:error?.message||String(error)}}).catch(emitError=>{workerHeartbeatError=emitError;});});},heartbeatMs);
   workerHeartbeat.unref?.();
  };
  const stopWorkerHeartbeat=()=>{if(workerHeartbeat)clearInterval(workerHeartbeat);workerHeartbeat=null;};
  startWorkerHeartbeat();
  try{
   await this.emit('workflow.lease.acquired',{workflowId:instance.workflowId,leaseId:lease.leaseId,workerId:this.workerId});
   await this.emitState(instance,lease.previousState||'QUEUED',instance.state,lease);
   while(true){
    if(workerHeartbeatError){leaseLost=true;break;}
    if(lease.cancelled||instance.cancelRequested){const from=instance.state;if(instance.state!=='CANCELLED')instance.transition('CANCELLED');await this.emitState(instance,from,instance.state,lease);break;}
    if(lease.deadlineAt&&new Date(lease.deadlineAt).getTime()<=this.now()){instance.metadata.deadlineExceeded=true;instance.metadata.failureCode='WORKFLOW_DEADLINE_EXCEEDED';const from=instance.state;if(instance.state!=='FAILED')instance.transition('FAILED');await this.emitState(instance,from,instance.state,lease);break;}
    try{await this.scheduler.renewAsync(instance.workflowId,lease.leaseId);}catch(error){if(isLeaseLost(error)){leaseLost=true;break;}throw error;}if(workerHeartbeatError){leaseLost=true;break;}
    const ready=instance.readySteps();if(!ready.length){const done=instance.definition.steps.every(s=>instance.steps[s.id].state===WorkflowDefinition.STEP_STATES.COMPLETED);const from=instance.state;if(done)instance.transition('COMPLETED');else if(instance.state!=='FAILED'&&instance.state!=='CANCELLED')instance.transition('FAILED');await this.emitState(instance,from,instance.state,lease);break;}
    const step=ready[0];if(lease.fencingToken!==undefined&&typeof this.scheduler.assertCurrentAsync==='function'){try{await this.scheduler.assertCurrentAsync(instance.workflowId,lease.leaseId,lease.fencingToken);}catch(error){if(isLeaseLost(error)){leaseLost=true;break;}throw error;}}instance.markStepRunning(step.id);await this.emit('workflow.step.started',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id,attempt:instance.steps[step.id]?.attempts||0});
    try{
     const heartbeatMs=Math.max(1000,Math.floor(this.scheduler.leaseDurationMs/3));let heartbeatError=null;
     const heartbeat=setInterval(()=>{this.scheduler.renewAsync(instance.workflowId,lease.leaseId).catch(error=>{heartbeatError=error;});},heartbeatMs);
     let result;
     try{result=await this.executor({instance,step,lease});if(heartbeatError)throw heartbeatError;if(lease.fencingToken!==undefined&&typeof this.scheduler.assertCurrentAsync==='function')await this.scheduler.assertCurrentAsync(instance.workflowId,lease.leaseId,lease.fencingToken);}finally{clearInterval(heartbeat);}
     if(workerHeartbeatError){leaseLost=true;break;}
     if(instance.cancelRequested){const from=instance.state;instance.cancelStep(step.id);instance.transition('CANCELLED');await this.emitState(instance,from,instance.state,lease);break;}
     const executionId=result?.execution?.executionId||result?.executionId||null;if(typeof executionId==='string'&&executionId)instance.metadata={...instance.metadata,taskId:instance.metadata.taskId||instance.workflowId,executionId};instance.markStepCompleted(step.id,result);await this.emit('workflow.step.completed',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id,executionId});
    }catch(error){
     if(isLeaseLost(error)){leaseLost=true;break;}
     if(workerHeartbeatError){leaseLost=true;break;}
     if(error?.code==='APPROVAL_REQUIRED'){
      // Approval is a durable pause, not a failed step or a retryable tool error.
      // Keep the step pending and block recovery until an explicit resume path exists.
      instance.resetStepForRetry(step.id);
      instance.metadata={...instance.metadata,taskId:instance.metadata.taskId||instance.workflowId,executionId:error.executionContext?.executionId||null,approvalBlocked:true,approvalExecutionId:error.executionContext?.executionId||null,approvalId:error.executionContext?.approvalId||null,approvalRequiredAt:new Date(this.now()).toISOString()};
      const from=instance.state;if(instance.state!=='WAITING')instance.transition('WAITING');
      await this.emit('workflow.approval.required',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id,executionId:instance.metadata.approvalExecutionId,approvalId:instance.metadata.approvalId,approvalRequiredAt:instance.metadata.approvalRequiredAt});
      await this.emitState(instance,from,instance.state,lease);
      break;
     }
     instance.markStepFailed(step.id,error);instance.metadata.failedStepId=step.id;await this.emit('workflow.step.failed',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id,error:{code:error?.code||'WORKFLOW_STEP_FAILED',message:error?.message||String(error)}});const retried=this.retryClassifier(error,{instance,step,lease})&&await this.scheduler.retryAsync(instance,{error,priority:instance.metadata.priority||0,workerPrincipal:lease.workerPrincipal});if(retried)await this.emit('workflow.retry.scheduled',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id,retry:instance.retry});if(!retried){const from=instance.state;if(instance.state!=='FAILED')instance.transition('FAILED');instance.metadata.failureCode=error?.code||'WORKFLOW_STEP_FAILED';await this.emitState(instance,from,instance.state,lease);}else if(instance.state!=='RUNNING'){await this.emitState(instance,'RUNNING',instance.state,lease);if(instance.state==='QUEUED')await this.emitState(instance,'WAITING','QUEUED',lease);}break;
    }
   }
   if(leaseLost)return null;if(this.persistAfterTick)await this.scheduler.persistAsync(instance,lease.workerPrincipal);return instance;
  }finally{
   stopWorkerHeartbeat();this.currentWorkerPrincipal=null;
   try{await this.scheduler.releaseAsync(instance.workflowId,lease.leaseId);}catch(error){if(!leaseLost&&!isLeaseLost(error))throw error;}
  }
 }
 async emit(type,payload){return this.eventSink({eventId:crypto.randomUUID(),type,timestamp:new Date(this.now()).toISOString(),payload,workerPrincipal:this.currentWorkerPrincipal||this.workerPrincipal});}
 async emitState(instance,from,to,lease){if(from===to)return;const metadata={...(instance.metadata||{})};delete metadata.fencingToken;await this.emit('workflow.state.changed',{workflowId:instance.workflowId,leaseId:lease.leaseId,from,to,deadlineAt:instance.deadlineAt,metadata});}
}
module.exports=AsyncWorkflowWorker;
