const crypto=require('crypto');const WorkflowDefinition=require('./workflow-definition');const WorkflowInstance=require('./workflow-instance');
class AsyncWorkflowWorker{
 constructor({scheduler,executor,eventSink=null,workerId=crypto.randomUUID(),now=()=>Date.now(),retryClassifier=()=>true,capabilities=[],workerRegistry=null,workerLeaseMs=30000,tenantId=null}){
  this.scheduler=scheduler;this.executor=executor;this.eventSink=eventSink;this.workerId=workerId;this.now=now;this.retryClassifier=retryClassifier;this.workerRegistry=workerRegistry;this.workerLeaseMs=Math.max(1000,Number(workerLeaseMs)||30000);this.tenantId=tenantId||scheduler?.tenantId||null;this.capabilities=Array.isArray(capabilities)?[...new Set(capabilities.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))]:[];
 }
 async tick(){
  await this.replayPendingPublications();
  if(this.workerRegistry?.register){
   await this.workerRegistry.register({workerId:this.workerId,tenantId:this.tenantId,heartbeatAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+this.workerLeaseMs).toISOString(),status:'READY',capabilities:this.capabilities,metadata:{workerRuntime:'orient-one'}},this.tenantId);
  }
  const lease=await this.scheduler.leaseAsync(this.workerId,this.capabilities||[]);if(!lease)return null;
  const instance=lease.instance;this.currentInstance=instance;let leaseLost=false;let approvalSnapshotPersisted=false;let workerHeartbeatError=null;let workerHeartbeat=null;
  const startWorkerHeartbeat=()=>{
   if(!this.workerRegistry?.heartbeat)return;
   const heartbeatMs=Math.max(1000,Math.floor(this.workerLeaseMs/3));
   workerHeartbeat=setInterval(()=>{this.workerRegistry.heartbeat(this.workerId,{tenantId:this.tenantId,heartbeatAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+this.workerLeaseMs).toISOString(),status:'READY'}).catch(error=>{workerHeartbeatError=error;void this.emit('worker.heartbeat.failed',{workerId:this.workerId,error:{code:error?.code||'WORKER_HEARTBEAT_FAILED',message:error?.message||String(error)}}).catch(publishError=>{workerHeartbeatError=publishError;});});},heartbeatMs);
   workerHeartbeat.unref?.();
  };
  const stopWorkerHeartbeat=()=>{if(workerHeartbeat)clearInterval(workerHeartbeat);workerHeartbeat=null;};
  startWorkerHeartbeat();
  try{
   await this.emit('workflow.lease.acquired',{workflowId:instance.workflowId,leaseId:lease.leaseId,workerId:this.workerId});await this.emitState(instance,lease.previousState||'QUEUED',instance.state,lease);
   while(true){
    if(workerHeartbeatError){leaseLost=true;break;}
    if(lease.cancelled||instance.cancelRequested){const from=instance.state;if(instance.state!=='CANCELLED')instance.transition('CANCELLED');await this.emitState(instance,from,instance.state,lease);break;}
    if(lease.deadlineAt&&new Date(lease.deadlineAt).getTime()<=this.now()){instance.metadata.deadlineExceeded=true;instance.metadata.failureCode='WORKFLOW_DEADLINE_EXCEEDED';const from=instance.state;if(instance.state!=='FAILED')instance.transition('FAILED');await this.emitState(instance,from,instance.state,lease);break;}
    await this.scheduler.renewAsync(instance.workflowId,lease.leaseId);if(workerHeartbeatError){leaseLost=true;break;}
    const ready=instance.readySteps();if(!ready.length){const done=instance.definition.steps.every(s=>instance.steps[s.id].state===WorkflowDefinition.STEP_STATES.COMPLETED);const from=instance.state;if(done)instance.transition('COMPLETED');else if(instance.state!=='FAILED'&&instance.state!=='CANCELLED')instance.transition('FAILED');await this.emitState(instance,from,instance.state,lease);break;}
    const step=ready[0];if(lease.fencingToken!==undefined&&typeof this.scheduler.assertCurrentAsync==='function')await this.scheduler.assertCurrentAsync(instance.workflowId,lease.leaseId,lease.fencingToken);instance.markStepRunning(step.id);
    try{
     const heartbeatMs=Math.max(1000,Math.floor(this.scheduler.leaseDurationMs/3));let heartbeatError=null;
     const heartbeat=setInterval(()=>{this.scheduler.renewAsync(instance.workflowId,lease.leaseId).catch(error=>{heartbeatError=error;});},heartbeatMs);
     let result;
     try{result=await this.executor({instance,step,lease});if(heartbeatError)throw heartbeatError;if(lease.fencingToken!==undefined&&typeof this.scheduler.assertCurrentAsync==='function')await this.scheduler.assertCurrentAsync(instance.workflowId,lease.leaseId,lease.fencingToken);}finally{clearInterval(heartbeat);}
     if(workerHeartbeatError){leaseLost=true;break;}
     if(instance.cancelRequested){const from=instance.state;instance.cancelStep(step.id);instance.transition('CANCELLED');await this.emitState(instance,from,instance.state,lease);break;}
     const executionId=result?.execution?.executionId||result?.executionId||null;if(typeof executionId==='string'&&executionId)instance.metadata={...instance.metadata,taskId:instance.metadata.taskId||instance.workflowId,executionId};instance.markStepCompleted(step.id,result);await this.emit('workflow.step.completed',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id,executionId});
    }catch(error){
     if(error?.code==='WORKFLOW_LEASE_NOT_OWNER'||error?.code==='WORKFLOW_LEASE_EXPIRED'||error?.code==='WORKFLOW_FENCING_REJECTED'){leaseLost=true;break;}
     if(workerHeartbeatError){leaseLost=true;break;}
     if(error?.code==='APPROVAL_REQUIRED'){
      this.assertOutboxSupport();
      // Approval is a durable pause, not a failed step or a retryable tool error.
      // Keep the step pending and block recovery until an explicit resume path exists.
      instance.resetStepForRetry(step.id);
      instance.metadata={...instance.metadata,taskId:instance.metadata.taskId||instance.workflowId,executionId:error.executionContext?.executionId||null,approvalBlocked:true,approvalExecutionId:error.executionContext?.executionId||null,approvalId:error.executionContext?.approvalId||null,approvalRequiredAt:new Date(this.now()).toISOString()};
      const from=instance.state;if(instance.state!=='WAITING')instance.transition('WAITING');
      // Persist the pending publications in the same workflow snapshot as the
      // approval pause. A restart can replay them with their original event IDs.
      const pendingPublications=[];
      if(from!==instance.state)pendingPublications.push(this.createEvent('workflow.state.changed',{workflowId:instance.workflowId,leaseId:lease.leaseId,from,to:instance.state}));
      pendingPublications.push(this.createEvent('workflow.approval.required',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id,executionId:instance.metadata.approvalExecutionId,approvalId:instance.metadata.approvalId}));
      instance.metadata={...instance.metadata,pendingPublications};
      await this.scheduler.persistAsync(instance);
      approvalSnapshotPersisted=true;
      for(const event of pendingPublications)await this.publish(event,instance,true);
      await this.acknowledgePendingPublications(instance,pendingPublications);
      break;
     }
     instance.markStepFailed(step.id,error);instance.metadata.failedStepId=step.id;const retried=this.retryClassifier(error,{instance,step,lease})&&await this.scheduler.retryAsync(instance,{error,priority:instance.metadata.priority||0});if(!retried){const from=instance.state;if(instance.state!=='FAILED')instance.transition('FAILED');await this.emitState(instance,from,instance.state,lease);instance.metadata.failureCode=error?.code||'WORKFLOW_STEP_FAILED';}else if(instance.state!=='RUNNING'){await this.emitState(instance,'RUNNING',instance.state,lease);if(instance.state==='QUEUED')await this.emitState(instance,'WAITING','QUEUED',lease);}break;
    }
   }
   if(leaseLost)return null;if(!approvalSnapshotPersisted)await this.scheduler.persistAsync(instance);return instance;
  }finally{
   stopWorkerHeartbeat();
   this.currentInstance=null;
   try{await this.scheduler.releaseAsync(instance.workflowId,lease.leaseId);}catch(error){if(!leaseLost&&!['WORKFLOW_LEASE_NOT_OWNER','WORKFLOW_LEASE_EXPIRED'].includes(error?.code))throw error;}
  }
 }
 createEvent(type,payload){return {eventId:crypto.randomUUID(),type,timestamp:new Date(this.now()).toISOString(),payload};}
 async publish(event,instance=this.currentInstance||null,required=false){if(typeof this.eventSink!=='function'){if(required)throw Object.assign(new Error('Durable workflow event sink is required for approval publication'),{code:'WORKFLOW_EVENT_SINK_REQUIRED'});return null;}const receipt=await this.eventSink(event,instance,{persist:false});if(required&&(!receipt||receipt.id!==event.eventId||!Number.isInteger(receipt.sequence)))throw Object.assign(new Error('Approval event sink did not return a durable append receipt'),{code:'WORKFLOW_EVENT_NOT_DURABLE'});return receipt;}
 async emit(type,payload){return await this.publish(this.createEvent(type,payload),this.currentInstance||null);}
 async emitState(instance,from,to,lease){if(from===to)return;return await this.emit('workflow.state.changed',{workflowId:instance.workflowId,leaseId:lease.leaseId,from,to});}
 assertOutboxSupport(){
  const repository=this.scheduler?.workflowRepository;
  if(!repository||typeof repository.save!=='function'||typeof repository.findPendingPublications!=='function'||
     typeof repository.acknowledgePendingPublications!=='function'||typeof this.scheduler.persistAsync!=='function'){
   throw Object.assign(new Error('Workflow repository does not support durable approval outbox operations'),{code:'WORKFLOW_OUTBOX_UNSUPPORTED'});
  }
 }
 async replayPendingPublications(){
  const repository=this.scheduler?.workflowRepository;
  if(!repository)return 0;
  this.assertOutboxSupport();
  const tenantId=this.tenantId||this.scheduler.tenantId||'local';
  const snapshots=await repository.findPendingPublications({tenantId,limit:100});
  let replayed=0;
  for(const snapshot of snapshots||[]){
   const pending=snapshot?.metadata?.pendingPublications;
   if(!snapshot||snapshot.metadata?.approvalBlocked!==true||!Array.isArray(pending)||pending.length===0)continue;
   const instance=WorkflowInstance.fromJSON(snapshot);
   for(const event of pending){await this.publish(event,instance,true);replayed++;}
   await this.acknowledgePendingPublications(instance,pending);
  }
  return replayed;
 }
 async acknowledgePendingPublications(instance,events){
  this.assertOutboxSupport();
  const repository=this.scheduler.workflowRepository;
  const eventIds=events.map(event=>event.eventId);
  const tenantId=instance.tenantId||this.tenantId||this.scheduler.tenantId||'local';
  const result=await repository.acknowledgePendingPublications(instance.workflowId,tenantId,eventIds);
  instance.metadata={...instance.metadata,pendingPublications:result.pending||[]};
  if(Number.isInteger(result.revision)&&typeof instance.setCheckpointRevision==='function')instance.setCheckpointRevision(result.revision,result.lastSavedAt);
  return result;
 }
}
module.exports=AsyncWorkflowWorker;
