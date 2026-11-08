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


test('scheduler clears stale fencing metadata only after it successfully releases the durable lease',async()=>{
  const saves=[];
  const scheduler=new AsyncWorkflowScheduler({
    tenantId:'tenant-a',
    workflowRepository:{async save(instance,tenantId,options){saves.push({instance,tenantId,options});return instance;}}
  });
  const instance={workflowId:'workflow-release',tenantId:'tenant-a',state:'WAITING',metadata:{fencingToken:23}};
  const principal=createWorkerPersistencePrincipal({
    tenantId:'tenant-a',workerId:'worker-a',sessionId:'session-a',capabilities:[],
    workflowId:'workflow-release',leaseId:'lease-release',fencingToken:23
  });
  scheduler.active.set(instance.workflowId,{instance,leaseId:'lease-release',fencingToken:23,workerPrincipal:principal});
  scheduler.leaseStore.release=async()=>({released:true});
  assert.equal(await scheduler.releaseAsync(instance.workflowId,'lease-release'),true);
  assert.equal('fencingToken' in instance.metadata,false);
  assert.equal(scheduler.active.has(instance.workflowId),false);
  assert.equal(saves.length,0, 'lease release must not write a stale snapshot after ownership ends');
});

test('scheduler preserves fencing metadata when durable lease release reports lost ownership',async()=>{
  const saves=[];
  const scheduler=new AsyncWorkflowScheduler({
    tenantId:'tenant-a',
    workflowRepository:{async save(instance,tenantId,options){saves.push({instance,tenantId,options});throw Object.assign(new Error('another worker now owns the workflow'),{code:'WORKFLOW_FENCING_REQUIRED'});}}
  });
  const instance={workflowId:'workflow-stale-release',tenantId:'tenant-a',state:'WAITING',metadata:{fencingToken:29}};
  const principal=createWorkerPersistencePrincipal({
    tenantId:'tenant-a',workerId:'worker-a',sessionId:'session-a',capabilities:[],
    workflowId:'workflow-stale-release',leaseId:'lease-stale',fencingToken:29
  });
  scheduler.active.set(instance.workflowId,{instance,leaseId:'lease-stale',fencingToken:29,workerPrincipal:principal});
  scheduler.leaseStore.release=async()=>({released:false});
  assert.equal(await scheduler.releaseAsync(instance.workflowId,'lease-stale'),false);
  assert.equal(instance.metadata.fencingToken,29);
  assert.equal(scheduler.active.has(instance.workflowId),false);
  assert.equal(saves.length,0);
});
