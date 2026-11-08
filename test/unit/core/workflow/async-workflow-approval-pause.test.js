const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowWorker = require('../../../../src/core/workflow/async-workflow-worker');
const AsyncWorkflowScheduler = require('../../../../src/core/workflow/async-workflow-scheduler');
const { WorkflowDefinition, WorkflowInstance } = require('../../../../src/core/workflow');

test('approval-required pauses a workflow durably without retrying or failing the step', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-pause-regression',
    version: 1,
    name: 'Approval pause regression',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({
    definition,
    workflowId: 'approval-pause-workflow',
    tenantId: 'tenant-a',
    input: { goal: 'perform guarded operation' }
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');

  const events = [];
  const persisted = [];
  let retryCalls = 0;
  let executorCalls = 0;
  const scheduler = {
    tenantId: 'tenant-a',
    leaseDurationMs: 5000,
    workflowRepository: { async save() {}, async findPendingPublications() { return []; }, async acknowledgePendingPublications() { return { pending: [] }; } },
    async leaseAsync() {
      return {
        workflowId: instance.workflowId,
        instance,
        leaseId: 'lease-1',
        workerId: 'worker-1',
        fencingToken: 1,
        previousState: 'QUEUED',
        cancelled: false
      };
    },
    async renewAsync() {},
    async persistAsync(value) { persisted.push(value.toJSON()); },
    async releaseAsync() {},
    async assertCurrentAsync() {},
    async retryAsync() { retryCalls += 1; return true; }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler,
    eventSink: event => { events.push(event); return { id: event.eventId, sequence: events.length }; },
    workerId: 'worker-1',
    executor: async () => {
      executorCalls += 1;
      throw Object.assign(new Error('Human approval is required'), {
        code: 'APPROVAL_REQUIRED',
        executionContext: { executionId: 'execution-1', approvalId: 'approval-1' }
      });
    }
  });

  const result = await worker.tick();

  assert.equal(result.state, 'WAITING');
  assert.equal(result.steps.write.state, 'PENDING');
  assert.equal(result.metadata.approvalBlocked, true);
  assert.equal(result.metadata.approvalExecutionId, 'execution-1');
  assert.equal(result.metadata.approvalId, 'approval-1');
  assert.equal(executorCalls, 1);
  assert.equal(retryCalls, 0);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].metadata.pendingPublications.length, 2);
  assert.deepEqual(result.metadata.pendingPublications, []);
  assert.ok(events.some(event => event.type === 'workflow.approval.required'));
  assert.ok(events.some(event => event.type === 'workflow.state.changed' && event.payload.to === 'WAITING'));
});


test('recovery never re-enqueues a persisted approval-blocked workflow', async () => {
  const scheduler = Object.create(AsyncWorkflowScheduler.prototype);
  scheduler.workflowRepository = {
    async findAll() {
      return [{
        workflowId: 'approval-blocked-after-restart',
        state: 'WAITING',
        metadata: { approvalBlocked: true, approvalExecutionId: 'execution-1', approvalId: 'approval-1' }
      }];
    }
  };
  scheduler.tenantId = 'tenant-a';
  scheduler.queue = [];
  scheduler.active = new Map();
  scheduler.maxQueueDepth = 10;
  scheduler.dispatchWindow = 1;

  const recovered = await scheduler.recoverPersisted('worker-1', []);

  assert.equal(recovered, 0);
  assert.equal(scheduler.queue.length, 0);
  assert.equal(scheduler.active.size, 0);
});


test('approval-required event is not published until the approval-blocked snapshot is durable', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-publication-order', version: 1, name: 'Approval publication order',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({ definition, workflowId: 'approval-publication-order', tenantId: 'tenant-a' });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  const order = [];
  const scheduler = {
    tenantId: 'tenant-a', leaseDurationMs: 5000,
    workflowRepository: { async save() {}, async findPendingPublications() { return []; }, async acknowledgePendingPublications() { order.push({ type: 'ack' }); return { pending: [] }; } },
    async leaseAsync() { return { instance, leaseId: 'lease-order', workerId: 'worker-order', fencingToken: 1, previousState: 'QUEUED', cancelled: false }; },
    async renewAsync() {}, async assertCurrentAsync() {}, async releaseAsync() {},
    async persistAsync(value) { order.push({ type: 'persist', state: value.state, approvalBlocked: value.metadata.approvalBlocked, pendingCount: value.metadata.pendingPublications?.length || 0 }); }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler, workerId: 'worker-order',
    eventSink: async event => { await new Promise(resolve => setImmediate(resolve)); order.push({ type: 'event', eventType: event.type }); return { id: event.eventId, sequence: order.filter(item => item.type === 'event').length }; },
    executor: async () => { throw Object.assign(new Error('approval required'), { code: 'APPROVAL_REQUIRED', executionContext: { executionId: 'exec-order', approvalId: 'approval-order' } }); }
  });
  await worker.tick();
  const approvalIndex = order.findIndex(item => item.type === 'event' && item.eventType === 'workflow.approval.required');
  assert.ok(approvalIndex > 0);
  assert.ok(order.slice(0, approvalIndex).some(item => item.type === 'persist' && item.state === 'WAITING' && item.approvalBlocked === true && item.pendingCount === 2));
  assert.equal(order.filter(item => item.type === 'persist').length, 1, 'pending outbox is persisted before publication');
  assert.equal(order.at(-1).type, 'ack', 'outbox acknowledgement follows durable event publication');
});


test('approval-required event is not published when durable pause persistence fails', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-persist-failure', version: 1, name: 'Approval persistence failure',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({ definition, workflowId: 'approval-persist-failure', tenantId: 'tenant-a' });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  const events = [];
  const scheduler = {
    tenantId: 'tenant-a', leaseDurationMs: 5000,
    workflowRepository: { async save() {}, async findPendingPublications() { return []; }, async acknowledgePendingPublications() { return { pending: [] }; } },
    async leaseAsync() { return { instance, leaseId: 'lease-fail', workerId: 'worker-fail', fencingToken: 1, previousState: 'QUEUED', cancelled: false }; },
    async renewAsync() {}, async assertCurrentAsync() {}, async releaseAsync() {},
    async persistAsync() { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler, workerId: 'worker-fail', eventSink: event => events.push(event),
    executor: async () => { throw Object.assign(new Error('approval required'), { code: 'APPROVAL_REQUIRED', executionContext: { executionId: 'exec-fail', approvalId: 'approval-fail' } }); }
  });
  await assert.rejects(worker.tick(), /disk unavailable/);
  assert.equal(events.some(event => event.type === 'workflow.approval.required'), false);
});

test('worker releases its lease when initial durable event publication fails', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-event-write-failure', version: 1, name: 'Event write failure',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({ definition, workflowId: 'approval-event-write-failure', tenantId: 'tenant-a' });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  let released = false;
  const scheduler = {
    tenantId: 'tenant-a', leaseDurationMs: 5000,
    async leaseAsync() { return { instance, leaseId: 'lease-event-failure', workerId: 'worker-event-failure', previousState: 'QUEUED', cancelled: false }; },
    async releaseAsync() { released = true; }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler,
    workerId: 'worker-event-failure',
    eventSink: async () => { throw Object.assign(new Error('event store unavailable'), { code: 'EIO' }); },
    executor: async () => { throw new Error('executor must not run'); }
  });
  await assert.rejects(worker.tick(), /event store unavailable/);
  assert.equal(released, true);
});

test('approval publication outbox replays stable event IDs after crash between append and acknowledgement', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-outbox-recovery', version: 1, name: 'Approval outbox recovery',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({ definition, workflowId: 'approval-outbox-recovery', tenantId: 'tenant-a' });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  let persistedSnapshot = null;
  let leaseCalls = 0;
  let crashAfterFirstWaitingEvent = true;
  const attempts = [];
  const committed = new Map();
  const scheduler = {
    tenantId: 'tenant-a',
    leaseDurationMs: 5000,
    workflowRepository: {
      async save() {},
      async findPendingPublications() { return persistedSnapshot ? [persistedSnapshot] : []; },
      async acknowledgePendingPublications(workflowId, tenantId, eventIds) {
        assert.equal(workflowId, 'approval-outbox-recovery');
        assert.equal(tenantId, 'tenant-a');
        const ids = new Set(eventIds);
        const pending = persistedSnapshot.metadata.pendingPublications;
        const remaining = pending.filter(event => !ids.has(event.eventId));
        persistedSnapshot = { ...persistedSnapshot, metadata: { ...persistedSnapshot.metadata, pendingPublications: remaining } };
        return { acknowledged: pending.length - remaining.length, pending: remaining };
      }
    },
    async persistAsync(value) { persistedSnapshot = value.toJSON(); },
    async leaseAsync() {
      leaseCalls += 1;
      return leaseCalls === 1
        ? { instance, leaseId: 'lease-outbox', workerId: 'worker-outbox', fencingToken: 1, previousState: 'QUEUED', cancelled: false }
        : null;
    },
    async renewAsync() {}, async assertCurrentAsync() {}, async releaseAsync() {}
  };
  const eventSink = async (event, workflow) => {
    attempts.push({ eventId: event.eventId, type: event.type, state: workflow?.state });
    if (!committed.has(event.eventId)) committed.set(event.eventId, event);
    if (event.type === 'workflow.state.changed' && event.payload.to === 'WAITING' && crashAfterFirstWaitingEvent) {
      crashAfterFirstWaitingEvent = false;
      throw new Error('simulated process crash after event commit');
    }
    return { id: event.eventId, sequence: committed.size };
  };
  const firstWorker = new AsyncWorkflowWorker({
    scheduler, workerId: 'worker-outbox', eventSink,
    executor: async () => { throw Object.assign(new Error('approval required'), { code: 'APPROVAL_REQUIRED', executionContext: { executionId: 'exec-outbox', approvalId: 'approval-outbox' } }); }
  });

  await assert.rejects(firstWorker.tick(), /simulated process crash after event commit/);
  assert.equal(persistedSnapshot.state, 'WAITING');
  assert.equal(persistedSnapshot.metadata.pendingPublications.length, 2);

  const restartedWorker = new AsyncWorkflowWorker({
    scheduler, workerId: 'worker-outbox-restarted', eventSink,
    executor: async () => { throw new Error('executor must not run during outbox replay'); }
  });
  const result = await restartedWorker.tick();

  assert.equal(result, null);
  assert.equal(committed.size, 4, 'lease, running-state, waiting-state, and approval events are uniquely committed');
  const waitingAttempts = attempts.filter(item => item.type === 'workflow.state.changed' && item.state === 'WAITING');
  assert.equal(waitingAttempts.length, 2, 'the committed state event is retried with the same stable ID');
  assert.equal(waitingAttempts[0].eventId, waitingAttempts[1].eventId);
  assert.equal([...committed.values()].filter(event => event.type === 'workflow.approval.required').length, 1);
  assert.deepEqual(persistedSnapshot.metadata.pendingPublications, []);
});

test('approval outbox is retained when no durable event sink is configured', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-outbox-no-sink', version: 1, name: 'Approval outbox without sink',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({ definition, workflowId: 'approval-outbox-no-sink', tenantId: 'tenant-a' });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  let persisted = null;
  let released = false;
  const scheduler = {
    tenantId: 'tenant-a', leaseDurationMs: 5000,
    workflowRepository: { async save() {}, async findPendingPublications() { return []; }, async acknowledgePendingPublications() { return { pending: [] }; } },
    async leaseAsync() { return { instance, leaseId: 'lease-no-sink', workerId: 'worker-no-sink', previousState: 'QUEUED', cancelled: false }; },
    async renewAsync() {},
    async assertCurrentAsync() {},
    async persistAsync(value) { persisted = value.toJSON(); },
    async releaseAsync() { released = true; }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler, workerId: 'worker-no-sink',
    executor: async () => { throw Object.assign(new Error('approval required'), { code: 'APPROVAL_REQUIRED', executionContext: { executionId: 'exec-no-sink', approvalId: 'approval-no-sink' } }); }
  });
  await assert.rejects(worker.tick(), error => error.code === 'WORKFLOW_EVENT_SINK_REQUIRED');
  assert.equal(persisted.state, 'WAITING');
  assert.equal(persisted.metadata.pendingPublications.length, 2);
  assert.equal(released, true);
});

test('approval outbox remains pending when event sink does not return a durable receipt', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-outbox-no-receipt', version: 1, name: 'Approval outbox without receipt',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({ definition, workflowId: 'approval-outbox-no-receipt', tenantId: 'tenant-a' });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  let persisted = null;
  let released = false;
  const scheduler = {
    tenantId: 'tenant-a', leaseDurationMs: 5000,
    workflowRepository: { async save() {}, async findPendingPublications() { return []; }, async acknowledgePendingPublications() { return { pending: [] }; } },
    async leaseAsync() { return { instance, leaseId: 'lease-no-receipt', workerId: 'worker-no-receipt', previousState: 'QUEUED', cancelled: false }; },
    async renewAsync() {}, async assertCurrentAsync() {},
    async persistAsync(value) { persisted = value.toJSON(); },
    async releaseAsync() { released = true; }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler, workerId: 'worker-no-receipt', eventSink: async () => undefined,
    executor: async () => { throw Object.assign(new Error('approval required'), { code: 'APPROVAL_REQUIRED', executionContext: { executionId: 'exec-no-receipt', approvalId: 'approval-no-receipt' } }); }
  });
  await assert.rejects(worker.tick(), error => error.code === 'WORKFLOW_EVENT_NOT_DURABLE');
  assert.equal(persisted.metadata.pendingPublications.length, 2);
  assert.equal(released, true);
});
