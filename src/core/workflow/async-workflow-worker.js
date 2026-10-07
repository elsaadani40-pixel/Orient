const crypto=require('crypto');const WorkflowDefinition=require('./workflow-definition');
class AsyncWorkflowWorker{constructor({scheduler,executor,eventSink=()=>{},workerId=crypto.randomUUID(),now=()=>Date.now(),retryClassifier=()=>true}){this.scheduler=scheduler;this.executor=executor;this.eventSink=eventSink;this.workerId=workerId;this.now=now;this.retryClassifier=retryClassifier;}
 async tick(){const lease=await this.scheduler.leaseAsync(this.workerId);if(!lease)return null;const instance=lease.instance;let leaseLost=false;this.emit('workflow.lease.acquired',{workflowId:instance.workflowId,leaseId:lease.leaseId,workerId:this.workerId});try{while(true){if(lease.cancelled||instance.cancelRequested){if(instance.state!=='CANCELLED')instance.transition('CANCELLED');break;}if(lease.deadlineAt&&new Date(lease.deadlineAt).getTime()<=this.now()){instance.metadata.deadlineExceeded=true;instance.metadata.failureCode='WORKFLOW_DEADLINE_EXCEEDED';if(instance.state!=='FAILED')instance.transition('FAILED');break;}await this.scheduler.renewAsync(instance.workflowId,lease.leaseId);const ready=instance.readySteps();if(!ready.length){const done=instance.definition.steps.every(s=>instance.steps[s.id].state===WorkflowDefinition.STEP_STATES.COMPLETED);if(done)instance.transition('COMPLETED');else if(instance.state!=='FAILED'&&instance.state!=='CANCELLED')instance.transition('FAILED');break;}const step=ready[0];instance.markStepRunning(step.id);try{const heartbeatMs=Math.max(1000,Math.floor(this.scheduler.leaseDurationMs/3));
      let heartbeatError=null;
      const heartbeat=setInterval(()=>{this.scheduler.renewAsync(instance.workflowId,lease.leaseId).catch(error=>{heartbeatError=error;});},heartbeatMs);
      let result;
      try {
        result=await this.executor({instance,step,lease});
        if(heartbeatError) throw heartbeatError;
      } finally {
        clearInterval(heartbeat);
      }
      if(instance.cancelRequested){instance.cancelStep(step.id);instance.transition('CANCELLED');break;}
      instance.markStepCompleted(step.id,result);this.emit('workflow.step.completed',{workflowId:instance.workflowId,leaseId:lease.leaseId,stepId:step.id});}catch(error){
        if(error?.code==='WORKFLOW_LEASE_NOT_OWNER'||error?.code==='WORKFLOW_LEASE_EXPIRED'||error?.code==='WORKFLOW_FENCING_REJECTED'){leaseLost=true;break;}
        instance.markStepFailed(step.id,error);instance.metadata.failedStepId=step.id;const retried=this.retryClassifier(error,{instance,step,lease})&&await this.scheduler.retryAsync(instance,{error,priority:instance.metadata.priority||0});if(!retried){if(instance.state!=='FAILED')instance.transition('FAILED');instance.metadata.failureCode=error?.code||'WORKFLOW_STEP_FAILED';}break;}}if(leaseLost)return null;await this.scheduler.persistAsync(instance);return instance;}finally{try{await this.scheduler.releaseAsync(instance.workflowId,lease.leaseId);}catch(error){if(!leaseLost&&!['WORKFLOW_LEASE_NOT_OWNER','WORKFLOW_LEASE_EXPIRED'].includes(error?.code))throw error;}}}
 emit(type,payload){this.eventSink({eventId:crypto.randomUUID(),type,timestamp:new Date(this.now()).toISOString(),payload});}}
module.exports=AsyncWorkflowWorker;
