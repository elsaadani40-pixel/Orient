const test=require('node:test');
const assert=require('node:assert/strict');
const {WorkflowDefinition,WorkflowInstance,AsyncWorkflowScheduler}=require('../../../../src/core/workflow');

function instance(input,stepInput={ok:true}){return new WorkflowInstance({tenantId:'tenant-a',definition:new WorkflowDefinition({id:'quota',name:'Quota',steps:[{id:'a',tool:'noop',input:stepInput}]}),input});}

test('scheduler rejects workflow input above tenant quota before durable admission',async()=>{
 const scheduler=new AsyncWorkflowScheduler({tenantId:'tenant-a',quotaPolicy:{maxInputChars:5,maxToolInputChars:100,maxConcurrent:1,maxQueued:10}});
 await assert.rejects(()=>scheduler.enqueueDurable(instance({large:'payload'})),e=>e.code==='TENANT_INPUT_QUOTA_EXCEEDED');
});

test('scheduler rejects tool input above tenant quota before durable admission',async()=>{
 const scheduler=new AsyncWorkflowScheduler({tenantId:'tenant-a',quotaPolicy:{maxInputChars:100,maxToolInputChars:5,maxConcurrent:1,maxQueued:10}});
 await assert.rejects(()=>scheduler.enqueueDurable(instance({}, {large:'payload'})),e=>e.code==='TENANT_TOOL_INPUT_QUOTA_EXCEEDED');
});

test('scheduler accepts inputs within tenant quotas',async()=>{
 const saved=[];
 const scheduler=new AsyncWorkflowScheduler({tenantId:'tenant-a',quotaPolicy:{maxInputChars:100,maxToolInputChars:100,maxConcurrent:1,maxQueued:10},quotaRepository:{async reserveWorkflow(){return {}; }},workflowRepository:{async save(v){saved.push(v.toJSON());}}});
 const value=await scheduler.enqueueDurable(instance({ok:'yes'}));
 assert.equal(value.workflowId,saved[0].workflowId);
});
