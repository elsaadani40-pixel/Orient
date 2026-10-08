const crypto=require('crypto');const WorkflowDefinition=require('./workflow-definition');
class AsyncWorkflowWorker{
 constructor({scheduler,executor,eventSink=()=>{},workerId=crypto.randomUUID(),now=()=>Date.now(),retryClassifier=()=>true,capabilities=[],workerRegistry=null,workerLeaseMs=30000,tenantId=null}){
  this.scheduler=scheduler;this.executor=executor;this.eventSink=eventSink;this.workerId=workerId;this.now=now;this.retryClassifier=retryClassifier;this.workerRegistry=workerRegistry;this.workerLeaseMs=Math.max(1000,Number(workerLeaseMs)||30000);this.tenantId=tenantId||scheduler?.tenantId||null;this.capabilities=Array.isArray(capabilities)?[...new Set(capabilities.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))]:[];
 }
 async tick(){
  if(this.workerRegistry?.register){
   await this.workerRegistry.register({workerId:this.workerId,tenantId:this.tenantId,heartbeatAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+this.workerLeaseMs).toISOString(),status:'READY',capabilities:this.capabilities,metadata:{workerRuntime:'orient-one'}},this.tenantId);
  }
  const lease=await this.scheduler.leaseAsync(this.workerId,this.capabilities||[]);if(!lease)return null;
  const instance=lease.instance;let leaseLost=false;let workerHeartbeatError=null;let workerHeartbeat=null;
  const startWorkerHeartbeat=()=>{
   if(!this.workerRegistry?.heartbeat)return;
   const heartbeatMs=Math.max(1000,Math.floor(this.workerLeaseMs/3));
   workerHeartbeat=setInterval(()=>{this.workerRegistry.heartbeat(this.workerId,{tenantId:this.tenantId,heartbeatAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+this.workerLeaseMs).toISOString(),status:'READY'}).catch(error=>{workerHeartbeatError=error;this.emit('worker.heartbeat.failed',{workerId:this.workerId,error:{code:error?.code||'WORKER_HEARTBEAT_FAILED',message:error?.message||String(error)}});});},heartbeatMs);
   workerHeartbeat.unref?.();
  };
  const stopWorkerHeartbeat=()=>{if(workerHeartbeat)clearInterval(workerHeartbeat);workerHeartbeat=null;};
  startWorkerHeartbeat();
  this.emit('workflow.lease.acquired',{workflowId:instance.workflowId,leaseId:lease.leaseId,workerId:this.workerId});this.emitState(instance,lease.previousState||'QUEUED',instance.state,lease);
  try{
   while(true){
    if(workerHeartbeatError){leaseLost=true;break;}
    if(lease.cancelled||instance.cancelRequested){const from=instance.state;if(instance.state!=='CANCELLED')instance.transition('CANCELLED');this.emitState(instance,from,instance.state,lease);break;}
    if(lease.deadlineAt&&new Date(lease.deadlineAt).getTime()<=this.now()){instance.metadata.deadlineExceeded=true;instance.metadata.failureCode='WORKFLOW_DEADLINE_EXCEEDED';const from=instance.state;if(instance.state!=='FAILED')instance.transition('FAILED');this.emitState(instance,from,instance.state,lease);break;}
    await this.scheduler.renewAsync(instance.workflowId,lease.leaseId);if(workerHeartbeatError){leaseLost=true;break;}
    const ready=instance.readySteps();if(!ready.length){const done=instance.definition.steps.every(s=>instance.steps[s.id].state===WorkflowDefinition.STEP_STATES.COMPLETED);const from=instance.state;if(done)instance.transition('COMPLETED');else if(instance.state!=='FAILED'&&instance.state!=='CANCELLED')instance.transition('FAILED');this.emitState(instance,from,instance.state,lease);break;}
    const step=ready[0];if(lease.fencingToken!==undefined&&typeof this.scheduler.assertCurrentAsync==='function')await this.scheduler.assertCurrentAsync(instance.workflowId,lease.leaseId,lease.fencingToken);instance.markStepRunning(step.id);
    try{
     const heartbeatMs=Math.max(1000,Math.floor(this.scheduler.leaseDurationMs/3));let heartbeatError=null;
     const heartbeat=setInterval(()=>{this.scheduler.renewAsync(instance.workflowId,lease.leaseId).catch(error=>{heartbeatError=error;});},heartbeatMs);
     let result;
     try{result=await this.executor({instance,step,lease});if(heartbeatError)throw heartbeatError;}finally{clearInterval(heartbeat);}
     if(workerHeartbeatError){leaseLost=true;break;}
     if(instance.cancelRequested){const from=instance.state;instance.cancelStep(step.id);instance.transition('CANCELLED');this.emitState(instance,from,instance.state,lease);break;}
     instance.markStepCompleted(step.id,result);this.emit('workflow.step.completed',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id});
    }catch(error){
     if(error?.code==='WORKFLOW_LEASE_NOT_OWNER'||error?.code==='WORKFLOW_LEASE_EXPIRED'||error?.code==='WORKFLOW_FENCING_REJECTED'){leaseLost=true;break;}
     if(workerHeartbeatError){leaseLost=true;break;}
     instance.markStepFailed(step.id,error);instance.metadata.failedStepId=step.id;const retried=this.retryClassifier(error,{instance,step,lease})&&await this.scheduler.retryAsync(instance,{error,priority:instance.metadata.priority||0});if(!retried){const from=instance.state;if(instance.state!=='FAILED')instance.transition('FAILED');this.emitState(instance,from,instance.state,lease);instance.metadata.failureCode=error?.code||'WORKFLOW_STEP_FAILED';}else if(instance.state!=='RUNNING'){this.emitState(instance,'RUNNING',instance.state,lease);if(instance.state==='QUEUED')this.emitState(instance,'WAITING','QUEUED',lease);}break;
    }
   }
   if(leaseLost)return null;await this.scheduler.persistAsync(instance);return instance;
  }finally{
   stopWorkerHeartbeat();
   try{await this.scheduler.releaseAsync(instance.workflowId,lease.leaseId);}catch(error){if(!leaseLost&&!['WORKFLOW_LEASE_NOT_OWNER','WORKFLOW_LEASE_EXPIRED'].includes(error?.code))throw error;}
  }
 }
 emit(type,payload){this.eventSink({eventId:crypto.randomUUID(),type,timestamp:new Date(this.now()).toISOString(),payload});}
 emitState(instance,from,to,lease){if(from===to)return;this.emit('workflow.state.changed',{workflowId:instance.workflowId,leaseId:lease.leaseId,from,to});}
}
module.exports=AsyncWorkflowWorker;
