const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkflowDefinition, WorkflowInstance, WorkflowScheduler, WorkflowWorker } = require('../../../../src/core/workflow');
const WorkflowLeaseStore = require('../../../../src/core/workflow/workflow-lease-store');

function definition() {
  return new WorkflowDefinition({ id: 'reliability', version: 1, name: 'Reliability', steps: [{ id: 'a', tool: 'noop' }] });
}

test('lease store prevents concurrent ownership and recovers expired leases', () => {
  let now = 1000;
  const repository = {
    values: new Map(),
    save(lease) { this.values.set(lease.workflowId, { ...lease }); },
    findByWorkflowId(id) { return this.values.get(id) || null; },
    findAll() { return [...this.values.values()]; },
    delete(id) { return this.values.delete(id); },
    deleteExpired(id) { return this.values.delete(id); }
  };
  const store = new WorkflowLeaseStore({ repository, clock: () => now, leaseDurationMs: 1000 });
  const first = store.acquire('wf', 'worker-a');
  assert.throws(() => store.acquire('wf', 'worker-b'), /already held/);
  now = 2501;
  assert.equal(store.recoverExpired().length, 1);
  const second = store.acquire('wf', 'worker-b');
  assert.notEqual(first.leaseId, second.leaseId);
});

test('scheduler retries with exponential backoff and preserves attempt state', () => {
  let now = 1000;
  const scheduler = new WorkflowScheduler({ maxConcurrent: 1, clock: () => now, maxRetries: 2, baseBackoffMs: 100, maxBackoffMs: 1000 });
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'retry-wf' });
  scheduler.enqueue(instance);
  const lease = scheduler.lease('worker');
  scheduler.release(lease.workflowId, lease.leaseId);
  instance.metadata.failedStepId = 'a';
  instance.markStepFailed('a', Object.assign(new Error('temporary'), { code: 'TEMPORARY' }));
  assert.equal(scheduler.retry(instance, { error: new Error('temporary') }), true);
  assert.equal(instance.retry.attempt, 1);
  assert.equal(instance.state, 'QUEUED');
  assert.equal(instance.steps.a.state, 'PENDING');
  now = 1101;
  const next = scheduler.lease('worker-2');
  assert.equal(next.workflowId, 'retry-wf');
  scheduler.release(next.workflowId, next.leaseId);
});

test('worker enforces deadline and emits durable operational events', async () => {
  let now = 1000;
  const scheduler = new WorkflowScheduler({ maxConcurrent: 1, clock: () => now, leaseDurationMs: 5000 });
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'deadline-wf' });
  scheduler.enqueue(instance, { deadlineAt: new Date(1100).toISOString() });
  const events = [];
  const worker = new WorkflowWorker({
    scheduler,
    now: () => now,
    eventSink: event => events.push(event),
    executor: async () => { now = 1200; return { ok: true }; }
  });
  const result = await worker.tick();
  assert.equal(result.state, 'FAILED');
  assert.equal(result.metadata.failureCode, 'WORKFLOW_DEADLINE_EXCEEDED');
  assert.ok(events.some(event => event.type === 'workflow.deadline.exceeded'));
  assert.ok(events.some(event => event.type === 'workflow.lease.released'));
});

test('cancellation prevents queued execution', async () => {
  const scheduler = new WorkflowScheduler({ maxConcurrent: 1 });
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'cancel-wf' });
  scheduler.enqueue(instance);
  assert.equal(scheduler.cancel('cancel-wf'), true);
  const worker = new WorkflowWorker({ scheduler, executor: async () => ({ shouldNotRun: true }) });
  assert.equal(await worker.tick(), null);
  assert.equal(instance.state, 'CANCELLED');
});
