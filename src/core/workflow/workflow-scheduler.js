const AppError = require('../errors/AppError');

class WorkflowScheduler {
  constructor({ maxConcurrent=1, clock=()=>Date.now() }={}) { if(maxConcurrent<1) throw new AppError('maxConcurrent must be positive',400,'SCHEDULER_INVALID_LIMIT'); this.maxConcurrent=maxConcurrent; this.clock=clock; this.queue=[]; this.active=new Map(); this.cancelled=new Set(); }
  enqueue(instance,{priority=0,deadlineAt=null}={}){ if(!instance) throw new AppError('Workflow instance required',400,'SCHEDULER_WORKFLOW_REQUIRED'); instance.transition('QUEUED'); this.queue.push({instance,priority,sequence:this.clock(),deadlineAt}); this.queue.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence); return instance; }
  cancel(workflowId){this.cancelled.add(workflowId);const q=this.queue.find(x=>x.instance.workflowId===workflowId);if(q)q.instance.transition('CANCELLED');const active=this.active.get(workflowId);if(active)active.cancelled=true;return Boolean(q||active);}
  lease(){ while(this.queue.length){const item=this.queue.shift(); if(this.cancelled.has(item.instance.workflowId))continue; if(item.deadlineAt&&item.deadlineAt<=this.clock()){item.instance.transition('CANCELLED');continue;} if(this.active.size>=this.maxConcurrent){this.queue.unshift(item);return null;} item.instance.transition('RUNNING'); const lease={workflowId:item.instance.workflowId,instance:item.instance,leaseId:cryptoRandom(),issuedAt:this.clock(),deadlineAt:item.deadlineAt,cancelled:false}; this.active.set(lease.workflowId,lease); return lease;} return null; }
  release(workflowId){return this.active.delete(workflowId);}
  depth(){return this.queue.length;} activeCount(){return this.active.size;}
}
function cryptoRandom(){return require('crypto').randomUUID();}
module.exports=WorkflowScheduler;