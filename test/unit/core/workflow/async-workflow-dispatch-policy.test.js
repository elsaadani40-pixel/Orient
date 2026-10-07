const test=require('node:test');
const assert=require('node:assert/strict');
const AsyncWorkflowScheduler=require('../../../../src/core/workflow/async-workflow-scheduler');
const {WorkflowDefinition,WorkflowInstance}=require('../../../../src/core/workflow');

function definition(id='dispatch-policy'){
  return new WorkflowDefinition({id,version:1,name:'Dispatch Policy',steps:[{id:'step',tool:'noop',input:{}}]});
}

function payload(workflowId,requiredCapabilities=[]){
  const instance=new WorkflowInstance({definition:definition(workflowId),workflowId,tenantId:'tenant-a'});
  instance.metadata={requiredCapabilities};
  return instance.toJSON();
}

test('async recovery applies bounded backpressure and passes worker capabilities to durable claims',async()=>{
  let claimArgs=null;
  const repository={
    async claimQueued(args){claimArgs=args;return[];},
    async save(){}
  };
  const scheduler=new AsyncWorkflowScheduler({
    tenantId:'tenant-a',
    workflowRepository:repository,
    maxConcurrent:2,
    maxQueueDepth:10,
    dispatchWindow:3,
    agingQuantumMs:15000
  });
  await scheduler.recoverPersisted('worker-a',['web.search','calendar.read']);
  assert.equal(claimArgs.limit,3);
  assert.deepEqual(claimArgs.workerCapabilities,['web.search','calendar.read']);
  assert.equal(claimArgs.agingQuantumMs,15000);

  for(let i=0;i<8;i++){
    const instance=WorkflowInstance.fromJSON(payload('queued-'+i));
    scheduler.enqueue(instance);
  }
  claimArgs=null;
  await scheduler.recoverPersisted('worker-a',['web.search']);
  assert.equal(claimArgs,null,'recovery must stop claiming when local queue capacity is exhausted');
});

test('async recovery does not enqueue workflows requiring unsupported capabilities',async()=>{
  const repository={
    async claimQueued(){return[
      payload('supported',['web.search']),
      payload('unsupported',['browser']),
      payload('generic',[])
    ];},
    async save(){}
  };
  const scheduler=new AsyncWorkflowScheduler({
    tenantId:'tenant-a',
    workflowRepository:repository,
    maxConcurrent:2,
    maxQueueDepth:10,
    dispatchWindow:10
  });
  const recovered=await scheduler.recoverPersisted('worker-a',['web.search']);
  assert.equal(recovered,2);
  assert.deepEqual(
    scheduler.queue.map(item=>item.instance.workflowId).sort(),
    ['generic','supported']
  );
});

test('async lease refuses a locally queued workflow when worker capabilities do not match',async()=>{
  const instance=WorkflowInstance.fromJSON(payload('browser-only',['browser']));
  const scheduler=new AsyncWorkflowScheduler({
    tenantId:'tenant-a',
    maxConcurrent:1,
    maxQueueDepth:5,
    leaseRepository:{
      async tryAcquire(){throw new Error('must not acquire');}
    }
  });
  scheduler.enqueue(instance);
  const lease=await scheduler.leaseAsync('worker-a',['web.search']);
  assert.equal(lease,null);
  assert.equal(scheduler.depth(),1);
  assert.equal(instance.state,'QUEUED');
});
