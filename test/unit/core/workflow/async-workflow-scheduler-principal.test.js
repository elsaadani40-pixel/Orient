'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const AsyncWorkflowScheduler=require('../../../../src/core/workflow/async-workflow-scheduler');
const {createWorkerPersistencePrincipal}=require('../../../../src/core/security/worker-persistence-principal');

test('scheduler passes the active lease-bound worker principal into workflow persistence',async()=>{
  const calls=[];
  const scheduler=new AsyncWorkflowScheduler({
    tenantId:'tenant-a',
    workflowRepository:{
      async save(instance,tenantId,options){calls.push({instance,tenantId,options});return instance;}
    }
  });
  const instance={workflowId:'workflow-a',tenantId:'tenant-a',state:'RUNNING',metadata:{fencingToken:17}};
  const principal=createWorkerPersistencePrincipal({
    tenantId:'tenant-a',workerId:'worker-a',sessionId:'session-a',capabilities:[],
    workflowId:'workflow-a',leaseId:'lease-a',fencingToken:17
  });
  scheduler.active.set(instance.workflowId,{workerPrincipal:principal});
  await scheduler.persistAsync(instance);
  assert.equal(calls.length,1);
  assert.equal(calls[0].instance,instance);
  assert.equal(calls[0].tenantId,'tenant-a');
  assert.equal(calls[0].options.workerPrincipal,principal);
});
