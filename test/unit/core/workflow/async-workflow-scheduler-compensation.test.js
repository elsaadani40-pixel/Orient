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


test('recovery save failure removes the queue entry and releases its claim', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'recovery-save-failure-wf',
    tenantId: 'tenant-compensation'
  });
  let releasedBy = null;
  const workflowRepository = {
    workerRegistry: { async register(worker) { return worker; } },
    async claimQueued() { return [instance.toJSON()]; },
    async save() { throw new Error('recovery write failed'); },
    async releaseDispatchClaim(workflowId, workerId) {
      releasedBy = { workflowId, workerId };
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
  await assert.rejects(
    () => scheduler.recoverPersisted(),
    /recovery write failed/
  );
  assert.equal(scheduler.depth(), 0);
  assert.deepEqual(releasedBy, {
    workflowId: instance.workflowId,
    workerId: scheduler.recoveryWorkerId
  });
});


test('expired recovered workflow releases its dispatch claim', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'recovered-deadline-claim-wf',
    tenantId: 'tenant-compensation'
  });
  instance.setDeadline(new Date(2000).toISOString());
  let now = 1000;
  let releasedBy = null;
  const workflowRepository = {
    workerRegistry: { async register(worker) { return worker; } },
    async claimQueued() { return [instance.toJSON()]; },
    async save() { return true; },
    async releaseDispatchClaim(workflowId, workerId) {
      releasedBy = { workflowId, workerId };
      return true;
    }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository,
    clock: () => now,
    dispatchWindow: 1,
    maxQueueDepth: 10
  });
  assert.equal(await scheduler.recoverPersisted(), 1);
  const owner = scheduler.queue[0].dispatchClaimWorkerId;
  now = 3000;
  assert.equal(await scheduler.leaseAsync('runtime-worker'), null);
  assert.deepEqual(releasedBy, {
    workflowId: instance.workflowId,
    workerId: owner
  });
});


test('recovery releases its dispatch claim when quota recovery fails', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'recovery-quota-restore-failure-wf',
    tenantId: 'tenant-compensation'
  });
  let releasedBy = null;
  const workflowRepository = {
    workerRegistry: { async register(worker) { return worker; } },
    async claimQueued() { return [instance.toJSON()]; },
    async releaseDispatchClaim(workflowId, workerId) {
      releasedBy = { workflowId, workerId };
      return true;
    }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository,
    quotaRepository: {
      async recoverWorkflow() { throw new Error('quota recovery unavailable'); },
      async reserveWorkflow() { return {}; }
    },
    clock: () => 1000,
    dispatchWindow: 1,
    maxQueueDepth: 10
  });

  await assert.rejects(
    () => scheduler.recoverPersisted(),
    /quota recovery unavailable/
  );
  assert.deepEqual(releasedBy, {
    workflowId: instance.workflowId,
    workerId: scheduler.recoveryWorkerId
  });
  assert.equal(scheduler.depth(), 0);
});


test('recovery releases its dispatch claim when persisting a quota failure throws', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'recovery-quota-save-failure-wf',
    tenantId: 'tenant-compensation'
  });
  instance.input = { oversized: 'input' };
  let releasedBy = null;
  const workflowRepository = {
    workerRegistry: { async register(worker) { return worker; } },
    async claimQueued() { return [instance.toJSON()]; },
    async save() { throw new Error('quota failure persistence unavailable'); },
    async releaseDispatchClaim(workflowId, workerId) {
      releasedBy = { workflowId, workerId };
      return true;
    }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository,
    quotaPolicy: { maxInputChars: 1 },
    clock: () => 1000,
    dispatchWindow: 1,
    maxQueueDepth: 10
  });

  await assert.rejects(
    () => scheduler.recoverPersisted(),
    /quota failure persistence unavailable/
  );
  assert.deepEqual(releasedBy, {
    workflowId: instance.workflowId,
    workerId: scheduler.recoveryWorkerId
  });
  assert.equal(scheduler.depth(), 0);
});

test('durable enqueue rolls back queue admission and quota when persistence fails', async () => {
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'durable-save-failure', tenantId: 'tenant-compensation' });
  const reservations = new Set();
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { throw new Error('durable write failed'); } },
    quotaRepository: {
      async reserveWorkflow({ workflowId }) { reservations.add(workflowId); return {}; },
      async releaseWorkflow({ workflowId }) { reservations.delete(workflowId); return true; }
    },
    clock: () => 1000
  });
  const originalUpdatedAt = instance.updatedAt;
  await assert.rejects(() => scheduler.enqueueDurable(instance, { deadlineAt: new Date(5000).toISOString() }), /durable write failed/);
  assert.equal(scheduler.depth(), 0);
  assert.equal(instance.state, 'CREATED');
  assert.equal(instance.deadlineAt, null);
  assert.equal(instance.updatedAt, originalUpdatedAt);
  assert.equal(reservations.has(instance.workflowId), false);
  assert.equal(await scheduler.leaseAsync('worker-after-failure'), null);
});

test('durable enqueue restores the original state and releases its reservation when the queue is full', async () => {
  const first = new WorkflowInstance({ definition: definition(), workflowId: 'durable-first', tenantId: 'tenant-compensation' });
  const rejected = new WorkflowInstance({ definition: definition(), workflowId: 'durable-rejected', tenantId: 'tenant-compensation' });
  const reservations = new Set();
  const released = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    maxQueueDepth: 1,
    workflowRepository: { async save() { return true; } },
    quotaRepository: {
      async reserveWorkflow({ workflowId }) { reservations.add(workflowId); return {}; },
      async releaseWorkflow({ workflowId }) { released.push(workflowId); reservations.delete(workflowId); return true; }
    },
    clock: () => 1000
  });
  await scheduler.enqueueDurable(first);
  const originalUpdatedAt = rejected.updatedAt;
  await assert.rejects(() => scheduler.enqueueDurable(rejected, { deadlineAt: new Date(5000).toISOString() }), error => error.code === 'SCHEDULER_QUEUE_FULL');
  assert.equal(scheduler.depth(), 1);
  assert.equal(scheduler.queue[0].instance, first);
  assert.equal(rejected.state, 'CREATED');
  assert.equal(rejected.deadlineAt, null);
  assert.equal(rejected.updatedAt, originalUpdatedAt);
  assert.equal(reservations.has(rejected.workflowId), false);
  assert.deepEqual(released, [rejected.workflowId]);
});

test('durable enqueue does not release a quota reservation created by an earlier attempt', async () => {
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'durable-existing-reservation', tenantId: 'tenant-compensation' });
  const reservations = new Set([instance.workflowId]);
  const released = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { throw new Error('durable write failed'); } },
    quotaRepository: {
      async reserveWorkflow() { return { created: false }; },
      async releaseWorkflow({ workflowId }) { released.push(workflowId); reservations.delete(workflowId); return true; }
    }
  });
  await assert.rejects(() => scheduler.enqueueDurable(instance), /durable write failed/);
  assert.equal(scheduler.depth(), 0);
  assert.equal(reservations.has(instance.workflowId), true);
  assert.deepEqual(released, []);
});

test('workers cannot lease a durable queue item before its persistence completes', async () => {
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'durable-pending-write', tenantId: 'tenant-compensation' });
  let finishSave;
  const saveGate = new Promise(resolve => { finishSave = resolve; });
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { await saveGate; return true; } },
    clock: () => 1000
  });
  const admission = scheduler.enqueueDurable(instance);
  assert.equal(await scheduler.leaseAsync('early-worker'), null);
  finishSave();
  await admission;
  const lease = await scheduler.leaseAsync('committed-worker');
  assert.ok(lease);
  assert.equal(lease.workflowId, instance.workflowId);
});
