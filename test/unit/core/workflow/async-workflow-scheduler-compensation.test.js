const test=require('node:test');
const assert=require('node:assert/strict');
const AsyncWorkflowScheduler=require('../../../../src/core/workflow/async-workflow-scheduler');
const {WorkflowDefinition,WorkflowInstance}=require('../../../../src/core/workflow');
function definition(){return new WorkflowDefinition({id:'compensation',version:1,name:'Compensation',steps:[{id:'step',tool:'noop',input:{}}]});}
test('quota promotion deferrals restore the queued workflow state before retrying lease acquisition', async () => {
  for (const mode of ['reservation-missing', 'concurrent-quota']) {
    const instance = new WorkflowInstance({
      definition: definition(),
      workflowId: 'quota-promotion-' + mode,
      tenantId: 'tenant-compensation'
    });
    let promotionAttempts = 0;
    const scheduler = new AsyncWorkflowScheduler({
      tenantId: 'tenant-compensation',
      workflowRepository: { async save() { return true; } },
      quotaRepository: {
        async reserveWorkflow() { return { created: true, reservedAt: '2026-11-04T00:00:00.000Z' }; },
        async promoteWorkflow() {
          promotionAttempts += 1;
          if (promotionAttempts === 1 && mode === 'reservation-missing') return null;
          if (promotionAttempts === 1) {
            throw Object.assign(new Error('concurrent quota limit reached'), {
              code: 'TENANT_CONCURRENT_QUOTA_EXCEEDED'
            });
          }
          return { promoted: true };
        }
      },
      clock: () => 1000,
      leaseDurationMs: 30000
    });

    await scheduler.enqueueDurable(instance);
    const queuedUpdatedAt = instance.updatedAt;
    const queuedMetadata = { ...instance.metadata };

    assert.equal(await scheduler.leaseAsync('worker-a'), null);
    assert.equal(instance.state, 'QUEUED', mode + ': state must return to QUEUED');
    assert.equal(instance.updatedAt, queuedUpdatedAt, mode + ': timestamp must be restored');
    assert.deepEqual(instance.metadata, queuedMetadata, mode + ': fencing metadata must be restored');
    assert.equal(scheduler.depth(), 1, mode + ': workflow must remain queued');
    assert.equal(await scheduler.leaseStore.get(instance.workflowId), null, mode + ': lease must be released');

    const retriedLease = await scheduler.leaseAsync('worker-a');
    assert.ok(retriedLease, mode + ': a later successful quota promotion must lease the workflow');
    assert.equal(instance.state, 'RUNNING');
  }
});

test('missing quota reservation is recreated before a queued workflow is retried', async () => {
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'quota-reservation-recreated', tenantId: 'tenant-compensation' });
  let reservationExists = false;
  let reserveCalls = 0;
  let promotionCalls = 0;
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { return true; } },
    quotaRepository: {
      async reserveWorkflow() { reserveCalls += 1; reservationExists = true; return { created: true }; },
      async promoteWorkflow() {
        promotionCalls += 1;
        if (!reservationExists) return null;
        reservationExists = false;
        return { promoted: true };
      },
      async releaseWorkflow() { reservationExists = false; return true; }
    },
    clock: () => 1000
  });
  await scheduler.enqueueDurable(instance);
  reservationExists = false;
  assert.equal(await scheduler.leaseAsync('worker-retry'), null);
  assert.equal(instance.state, 'QUEUED');
  assert.equal(scheduler.depth(), 1);
  const lease = await scheduler.leaseAsync('worker-retry');
  assert.ok(lease);
  assert.equal(reserveCalls, 2);
  assert.equal(promotionCalls, 2);
  assert.equal(instance.state, 'RUNNING');
});

test('unexpected quota promotion errors restore the workflow to the durable queue', async () => {
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'quota-promotion-unexpected-error', tenantId: 'tenant-compensation' });
  let promotionCalls = 0;
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { return true; } },
    quotaRepository: {
      async reserveWorkflow() { return { created: true }; },
      async promoteWorkflow() {
        promotionCalls += 1;
        if (promotionCalls === 1) throw new Error('quota database unavailable');
        return { promoted: true };
      }
    },
    clock: () => 1000
  });
  await scheduler.enqueueDurable(instance);
  const queuedUpdatedAt = instance.updatedAt;
  const queuedMetadata = { ...instance.metadata };
  await assert.rejects(() => scheduler.leaseAsync('worker-a'), /quota database unavailable/);
  assert.equal(instance.state, 'QUEUED');
  assert.equal(instance.updatedAt, queuedUpdatedAt);
  assert.deepEqual(instance.metadata, queuedMetadata);
  assert.equal(scheduler.depth(), 1);
  assert.equal(await scheduler.leaseStore.get(instance.workflowId), null);
  const lease = await scheduler.leaseAsync('worker-b');
  assert.ok(lease);
  assert.equal(instance.state, 'RUNNING');
});

test('queued cancellation releases its durable quota reservation', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'queued-cancel-quota-release',
    tenantId: 'tenant-compensation'
  });
  const savedStates = [];
  const released = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save(value) { savedStates.push(value.state); return true; } },
    quotaRepository: {
      async reserveWorkflow() { return { created: true }; },
      async releaseWorkflow(args) { released.push(args); return true; }
    },
    clock: () => 1000
  });

  await scheduler.enqueueDurable(instance);
  assert.equal(await scheduler.cancelAsync(instance.workflowId), true);
  assert.equal(instance.state, 'CANCELLED');
  assert.equal(savedStates.at(-1), 'CANCELLED');
  assert.deepEqual(released, [{
    tenantId: 'tenant-compensation',
    workflowId: instance.workflowId
  }]);
  assert.equal(scheduler.depth(), 0);
});

test('queued deadline expiry releases its durable quota reservation', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'queued-deadline-quota-release',
    tenantId: 'tenant-compensation'
  });
  let now = 1000;
  const released = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { return true; } },
    quotaRepository: {
      async reserveWorkflow() { return { created: true }; },
      async releaseWorkflow(args) { released.push(args); return true; }
    },
    clock: () => now
  });

  await scheduler.enqueueDurable(instance, { deadlineAt: new Date(2000).toISOString() });
  now = 3000;
  assert.equal(await scheduler.leaseAsync('worker-a'), null);
  assert.equal(instance.state, 'FAILED');
  assert.equal(instance.metadata.failureCode, 'WORKFLOW_DEADLINE_EXCEEDED');
  assert.deepEqual(released, [{
    tenantId: 'tenant-compensation',
    workflowId: instance.workflowId
  }]);
  assert.equal(scheduler.depth(), 0);
});

test('shutdown cancellation releases quota reservations for queued workflows', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'shutdown-cancel-quota-release',
    tenantId: 'tenant-compensation'
  });
  const released = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { return true; } },
    quotaRepository: {
      async reserveWorkflow() { return { created: true }; },
      async releaseWorkflow(args) { released.push(args); return true; }
    },
    clock: () => 1000
  });

  await scheduler.enqueueDurable(instance);
  await scheduler.shutdown({ cancelQueued: true });
  assert.equal(instance.state, 'CANCELLED');
  assert.deepEqual(released, [{
    tenantId: 'tenant-compensation',
    workflowId: instance.workflowId
  }]);
  assert.equal(scheduler.depth(), 0);
});

test('recovery retries quota cleanup for workflows already in a terminal state', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'terminal-recovery-quota-release',
    tenantId: 'tenant-compensation'
  });
  instance.state = 'CANCELLED';
  const released = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async findAll() { return [instance.toJSON()]; } },
    quotaRepository: {
      async releaseWorkflow(args) { released.push(args); return true; }
    },
    clock: () => 1000
  });

  assert.equal(await scheduler.recoverPersisted(), 0);
  assert.deepEqual(released, [{
    tenantId: 'tenant-compensation',
    workflowId: instance.workflowId
  }]);
});

test('delayed durable workflows keep their queued quota reservation until terminal cleanup', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'delayed-quota-reservation-retention',
    tenantId: 'tenant-compensation'
  });
  let now = 1000;
  let reservedExpiresAt = 'not-called';
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { return true; } },
    quotaRepository: {
      async reserveWorkflow(args) {
        reservedExpiresAt = args.expiresAt;
        return { created: true };
      },
      async promoteWorkflow() { return { promoted: true }; }
    },
    clock: () => now,
    leaseDurationMs: 30000
  });

  await scheduler.enqueueDurable(instance, { delayMs: 60000 });
  assert.equal(reservedExpiresAt, null);
  now = 200000;
  const lease = await scheduler.leaseAsync('worker-a');
  assert.ok(lease);
  assert.equal(instance.state, 'RUNNING');
});

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


test('recovery releases quota when an oversized persisted workflow is marked failed', async () => {
  const instance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'recovery-terminal-quota-release',
    tenantId: 'tenant-compensation',
    input: { oversized: 'input' }
  });
  const released = [];
  const workflowRepository = {
    workerRegistry: { async register(worker) { return worker; } },
    async claimQueued() { return [instance.toJSON()]; },
    async save(value) { assert.equal(value.state, 'FAILED'); return true; },
    async releaseDispatchClaim() { return true; }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository,
    quotaRepository: {
      async releaseWorkflow(args) { released.push(args); return true; }
    },
    quotaPolicy: { maxInputChars: 1 },
    clock: () => 1000,
    dispatchWindow: 1,
    maxQueueDepth: 10
  });

  assert.equal(await scheduler.recoverPersisted(), 0);
  assert.deepEqual(released, [{
    tenantId: 'tenant-compensation',
    workflowId: instance.workflowId
  }]);
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
  let releasedReservation = null;
  const reservationTimestamp = '2026-11-04T12:00:00.000Z';
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository: { async save() { throw new Error('durable write failed'); } },
    quotaRepository: {
      async reserveWorkflow({ workflowId }) { reservations.add(workflowId); return { created: true, reservedAt: reservationTimestamp }; },
      async releaseWorkflow(args) { releasedReservation = args; reservations.delete(args.workflowId); return true; }
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
  assert.equal(releasedReservation.reservedAt, reservationTimestamp);
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

test('recovery save failure preserves a quota reservation that already existed', async () => {
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'recovery-existing-reservation', tenantId: 'tenant-compensation' });
  let quotaReleases = 0;
  let claimReleases = 0;
  const workflowRepository = {
    workerRegistry: { async register(worker) { return worker; } },
    async claimQueued() { return [instance.toJSON()]; },
    async save() { throw new Error('recovery write failed'); },
    async releaseDispatchClaim() { claimReleases += 1; return true; }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-compensation',
    workflowRepository,
    quotaRepository: {
      async reserveWorkflow() { return { created: false }; },
      async releaseWorkflow() { quotaReleases += 1; return true; }
    },
    clock: () => 1000,
    dispatchWindow: 1,
    maxQueueDepth: 10
  });
  await assert.rejects(() => scheduler.recoverPersisted(), /recovery write failed/);
  assert.equal(scheduler.depth(), 0);
  assert.equal(claimReleases, 1);
  assert.equal(quotaReleases, 0);
});
