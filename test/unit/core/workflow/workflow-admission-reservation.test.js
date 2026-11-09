const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowScheduler = require('../../../../src/core/workflow/async-workflow-scheduler');
const { WorkflowDefinition, WorkflowInstance } = require('../../../../src/core/workflow');

function makeInstance(workflowId) {
  const definition = new WorkflowDefinition({
    id: 'admission-test', version: 1, name: 'Admission test',
    steps: [{ id: 'step', tool: 'noop', input: {} }]
  });
  return new WorkflowInstance({ definition, workflowId, tenantId: 'tenant-admission' });
}

test('queue capacity is reserved before durable creation callback', async () => {
  const scheduler = new AsyncWorkflowScheduler({ tenantId: 'tenant-admission', maxQueueDepth: 1 });
  await scheduler.enqueueDurable(makeInstance('already-queued'));
  let persisted = false;
  await assert.rejects(
    scheduler.enqueueDurable(makeInstance('must-not-persist'), { beforePersist: async () => { persisted = true; } }),
    error => error.code === 'SCHEDULER_QUEUE_FULL'
  );
  assert.equal(persisted, false);
  assert.equal(scheduler.queue.length, 1);
  assert.equal(scheduler.pendingEnqueues.size, 0);
});

test('tenant quota denial occurs before durable creation and releases queue reservation', async () => {
  let persisted = false;
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-admission', maxQueueDepth: 1,
    quotaRepository: { async reserveWorkflow() { throw Object.assign(new Error('quota denied'), { code: 'TENANT_QUOTA_EXCEEDED' }); } }
  });
  await assert.rejects(
    scheduler.enqueueDurable(makeInstance('quota-denied'), { beforePersist: async () => { persisted = true; } }),
    error => error.code === 'TENANT_QUOTA_EXCEEDED'
  );
  assert.equal(persisted, false);
  assert.equal(scheduler.queue.length, 0);
  assert.equal(scheduler.pendingEnqueues.size, 0);
});

test('concurrent enqueue calls cannot exceed queue capacity while quota reservation is pending', async () => {
  let releaseQuota;
  const quotaGate = new Promise(resolve => { releaseQuota = resolve; });
  let firstReservationStarted;
  const started = new Promise(resolve => { firstReservationStarted = resolve; });
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-admission', maxQueueDepth: 1,
    quotaRepository: { async reserveWorkflow() { firstReservationStarted(); await quotaGate; return {}; } }
  });
  let firstPersisted = false;
  const first = scheduler.enqueueDurable(makeInstance('concurrent-first'), {
    beforePersist: async () => { firstPersisted = true; }
  });
  await started;
  let secondPersisted = false;
  await assert.rejects(
    scheduler.enqueueDurable(makeInstance('concurrent-second'), { beforePersist: async () => { secondPersisted = true; } }),
    error => error.code === 'SCHEDULER_QUEUE_FULL'
  );
  assert.equal(secondPersisted, false);
  assert.equal(scheduler.pendingEnqueues.size, 1);
  releaseQuota();
  await first;
  assert.equal(firstPersisted, true);
  assert.equal(scheduler.queue.length, 1);
  assert.equal(scheduler.pendingEnqueues.size, 0);
});

test('durable creation failure releases quota and queue reservations', async () => {
  const released = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-admission', maxQueueDepth: 1,
    quotaRepository: {
      async reserveWorkflow() { return {}; },
      async releaseWorkflow(args) { released.push(args); return true; }
    }
  });
  await assert.rejects(
    scheduler.enqueueDurable(makeInstance('persist-fails'), {
      beforePersist: async () => { throw new Error('durable transaction failed'); }
    }),
    /durable transaction failed/
  );
  assert.equal(scheduler.queue.length, 0);
  assert.equal(scheduler.pendingEnqueues.size, 0);
  assert.equal(released.length, 1);
  assert.equal(released[0].workflowId, 'persist-fails');
});

test('same workflow cannot acquire two pending admission reservations', async () => {
  const scheduler = new AsyncWorkflowScheduler({ tenantId: 'tenant-admission', maxQueueDepth: 2 });
  const instance = makeInstance('duplicate-pending');
  const reservation = scheduler.reserveEnqueue(instance);
  assert.throws(() => scheduler.reserveEnqueue(instance), error => error.code === 'WORKFLOW_ALREADY_SCHEDULED');
  assert.equal(scheduler.releaseEnqueueReservation(reservation), true);
  assert.equal(scheduler.pendingEnqueues.size, 0);
});
