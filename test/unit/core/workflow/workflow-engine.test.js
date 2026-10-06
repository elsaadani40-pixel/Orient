const test=require('node:test');
const assert=require('node:assert/strict');
const {WorkflowDefinition,WorkflowInstance,WorkflowScheduler,WorkflowWorker}=require('../../../../src/core/workflow');

test('workflow definition rejects cycles and preserves versioned identity',()=>{
  assert.throws(()=>new WorkflowDefinition({id:'cyclic',name:'Cyclic',steps:[{id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']}]}),/cycle/i);
  const d=new WorkflowDefinition({id:'research',version:3,name:'Research',steps:[{id:'search',tool:'search'},{id:'rank',tool:'rank',dependsOn:['search']}]});
  assert.equal(d.key,'3:research');
});

test('workflow instance enforces lifecycle and dependency readiness',()=>{
  const d=new WorkflowDefinition({id:'flow',name:'Flow',steps:[{id:'a'},{id:'b',dependsOn:['a']}]});
  const w=new WorkflowInstance({definition:d,workflowId:'w1',tenantId:'t1'});
  assert.deepEqual(w.readySteps().map(s=>s.id),['a']);
  w.transition('QUEUED'); w.transition('RUNNING');
  w.markStepRunning('a'); w.markStepCompleted('a',{ok:true});
  assert.deepEqual(w.readySteps().map(s=>s.id),['b']);
  assert.throws(()=>w.transition('QUEUED'),/Invalid workflow transition/);
});

test('scheduler applies priority, concurrency and cancellation',()=>{
  const d=new WorkflowDefinition({id:'flow',name:'Flow',steps:[{id:'a'}]});
  const s=new WorkflowScheduler({maxConcurrent:1,clock:()=>1});
  const low=new WorkflowInstance({definition:d,workflowId:'low'}); const high=new WorkflowInstance({definition:d,workflowId:'high'});
  s.enqueue(low,{priority:1}); s.enqueue(high,{priority:10});
  const lease=s.lease(); assert.equal(lease.workflowId,'high');
  s.cancel('low'); assert.equal(low.state,'CANCELLED'); s.release('high');
});

test('worker executes dependency graph and emits observable lifecycle events',async()=>{
  const d=new WorkflowDefinition({id:'flow',name:'Flow',steps:[{id:'a'},{id:'b',dependsOn:['a']},{id:'c',dependsOn:['a']}]});
  const w=new WorkflowInstance({definition:d,workflowId:'wf-events'}); const s=new WorkflowScheduler({maxConcurrent:1}); s.enqueue(w);
  const events=[]; const worker=new WorkflowWorker({scheduler:s,eventSink:e=>events.push(e),executor:async({step})=>({step:step.id,ok:true})});
  const result=await worker.tick();
  assert.equal(result.state,'COMPLETED'); assert.equal(events.filter(e=>e.type==='workflow.step.completed').length,3); assert.equal(events[0].type,'workflow.lease.acquired'); assert.equal(events.at(-1).type,'workflow.lease.released');
});
