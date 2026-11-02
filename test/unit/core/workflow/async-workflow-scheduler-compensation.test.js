const test=require('node:test');
const assert=require('node:assert/strict');
const AsyncWorkflowScheduler=require('../../../../src/core/workflow/async-workflow-scheduler');
const {WorkflowDefinition,WorkflowInstance}=require('../../../../src/core/workflow');
function definition(){return new WorkflowDefinition({id:'compensation',version:1,name:'Compensation',steps:[{id:'step',tool:'noop',input:{}}]});}
test('async scheduler compensates lease and durable quota when persistence fails after acquisition',async()=>{
  const instance=new WorkflowInstance({definition:definition(),workflowId:'persist-failure-wf',tenantId:'tenant-compensation'});
  const leases=new Map(); const quotaCalls=[];
  let saveCalls=0; const workflowRepository={async save(){saveCalls+=1;if(saveCalls>1)throw new Error('persistence unavailable');},async findAll(){return[];}};
  const leaseRepository={async tryAcquire(){const lease={workflowId:instance.workflowId,leaseId:'lease-1',workerId:'worker-a',acquiredAt:1000,expiresAt:31000,fencingToken:1,metadata:{}};leases.set(instance.workflowId,lease);return lease;},async delete(){leases.clear();return true;},async findByWorkflowId(id){return leases.get(id)||null;},async findAll(){return [...leases.values()];}};
  const quotaRepository={async reserveWorkflow(){return{};},async promoteWorkflow(){return{};},async releaseWorkflow(args){quotaCalls.push(args);return true;}};
  const scheduler=new AsyncWorkflowScheduler({tenantId:'tenant-compensation',workflowRepository,leaseRepository,quotaRepository,quotaPolicy:{toJSON(){return{};}},clock:()=>1000,leaseDurationMs:30000});
  await scheduler.enqueueDurable(instance);
  await assert.rejects(()=>scheduler.leaseAsync('worker-a'),/persistence unavailable/);
  assert.equal(scheduler.active.size,0,'active record leaked');
  assert.equal(leases.size,0,'durable lease leaked');
  assert.equal(quotaCalls.length,1,'quota reservation leaked');
  assert.equal(quotaCalls[0].workflowId,instance.workflowId);
});


test('recovered workflow releases the dispatch claim owned by the recovery worker, not the runtime worker', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'recovered-dispatch-claim-wf',
    tenantId: 'tenant-compensation'
  });
  let claimOwner = null;
  let releasedClaim = null;
  const workflowRepository = {
    workerRegistry: {
      async register(worker) { claimOwner = worker.workerId; return worker; }
    },
    async claimQueued({ workerId }) {
      assert.equal(workerId, claimOwner);
      return [instance.toJSON()];
    },
    async save() { return true; },
    async releaseDispatchClaim(workflowId, workerId, tenantId) {
      releasedClaim = { workflowId, workerId, tenantId };
      return true;
    }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository,
    clock: () => 1000,
    leaseDurationMs: 30000,
    dispatchWindow: 1,
    maxQueueDepth: 10
  });

  assert.equal(await scheduler.recoverPersisted(), 1);
  assert.ok(claimOwner.startsWith('orient-recovery-'));
  assert.equal(scheduler.queue[0].dispatchClaimWorkerId, claimOwner);

  const lease = await scheduler.leaseAsync('runtime-worker-1');
  assert.equal(lease.workerId, 'runtime-worker-1');
  assert.deepEqual(releasedClaim, {
    workflowId: instance.workflowId,
    workerId: claimOwner,
    tenantId: 'tenant-compensation'
  });
});


test('recovery releases a dispatch claim when the worker lacks required capabilities', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'recovery-capability-skip-wf',
    tenantId: 'tenant-compensation'
  });
  instance.metadata.requiredCapabilities = ['gpu'];
  let released = false;
  const workflowRepository = {
    workerRegistry: { async register(worker) { return worker; } },
    async claimQueued() { return [instance.toJSON()]; },
    async releaseDispatchClaim() { released = true; return true; }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository,
    clock: () => 1000,
    dispatchWindow: 1,
    maxQueueDepth: 10
  });

  assert.equal(await scheduler.recoverPersisted(), 0);
  assert.equal(released, true);
  assert.equal(scheduler.depth(), 0);
});


test('recovered queued cancellation releases its dispatch claim', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'recovered-cancel-claim-wf',
    tenantId: 'tenant-compensation'
  });
  let released = null;
  const workflowRepository = {
    workerRegistry: { async register(worker) { return worker; } },
    async claimQueued() { return [instance.toJSON()]; },
    async save() { return true; },
    async releaseDispatchClaim(workflowId, workerId, tenantId) {
      released = { workflowId, workerId, tenantId };
      return true;
    }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository,
    clock: () => 1000,
    dispatchWindow: 1,
    maxQueueDepth: 10
  });
  assert.equal(await scheduler.recoverPersisted(), 1);
  const owner = scheduler.queue[0].dispatchClaimWorkerId;
  assert.equal(await scheduler.cancelAsync(instance.workflowId), true);
  assert.deepEqual(released, {
    workflowId: instance.workflowId,
    workerId: owner,
    tenantId: 'tenant-compensation'
  });
});
