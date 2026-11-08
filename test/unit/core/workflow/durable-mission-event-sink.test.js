const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventRepository = require('../../../../src/infrastructure/persistence/json/event.repository');
const WorkflowRepository = require('../../../../src/infrastructure/persistence/json/workflow.repository');
const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');
const DurableMissionEventSink = require('../../../../src/core/workflow/durable-mission-event-sink');
const AsyncWorkflowWorker = require('../../../../src/core/workflow/async-workflow-worker');

function instance() {
  return new WorkflowInstance({
    workflowId: 'step-37-mission',
    tenantId: 'local',
    definition: new WorkflowDefinition({
      id: 'step-37',
      version: 1,
      name: 'Step 37',
      steps: [{ id: 'work', tool: 'work' }]
    })
  });
}

test('canonical event sink persists event before snapshot projection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-step37-'));
  const events = new EventRepository(path.join(dir, 'events.json'));
  const workflows = new WorkflowRepository(path.join(dir, 'workflows.json'));
  const sink = new DurableMissionEventSink({ eventRepository: events, workflowRepository: workflows });

  const mission = instance();
  await sink.recordCreated(mission);
  await sink.recordState(mission, 'CREATED', 'QUEUED');

  const stored = events.findByAggregateId(mission.workflowId);
  assert.deepEqual(stored.map(e => [e.sequence, e.type]), [
    [1, 'workflow.created'],
    [2, 'workflow.state.changed']
  ]);
  assert.equal(workflows.findById(mission.workflowId).state, 'CREATED');

  workflows.save(mission);
  const restored = await sink.reconstruct(mission.workflowId);
  assert.equal(restored.state, 'QUEUED');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('event survives crash between event append and workflow snapshot persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-step37-crash-'));
  const events = new EventRepository(path.join(dir, 'events.json'));
  const failingWorkflowRepository = { save() { throw Object.assign(new Error('simulated crash'), { code: 'SIMULATED_CRASH' }); } };
  const sink = new DurableMissionEventSink({ eventRepository: events, workflowRepository: failingWorkflowRepository });

  const mission = instance();
  await sink.recordCreated(mission);
  await assert.rejects(
    async () => sink.recordState(mission, 'CREATED', 'QUEUED'),
    error => error.code === 'SIMULATED_CRASH' && error.missionEventSequence === 2
  );

  const restored = await sink.reconstruct(mission.workflowId);
  assert.equal(restored.state, 'QUEUED');
  assert.equal(restored.metadata.projection.lastSequence, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('event persistence failure is classified as a mission durability failure', async () => {
  const sink = new DurableMissionEventSink({
    eventRepository: { appendMissionEvent() { throw new Error('disk unavailable'); } }
  });
  const mission = instance();
  await assert.rejects(
    async () => sink.recordCreated(mission),
    error => error.code === 'MISSION_EVENT_PERSISTENCE_FAILED'
  );
});


test('approval-required worker event is durably recorded with its stable event identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-event-'));
  const events = new EventRepository(path.join(dir, 'events.json'));
  const workflows = new WorkflowRepository(path.join(dir, 'workflows.json'));
  const sink = new DurableMissionEventSink({ eventRepository: events, workflowRepository: workflows });
  const mission = instance();
  const event = { eventId: 'approval-event-stable-id', type: 'workflow.approval.required', timestamp: '2026-11-07T12:00:00.000Z', payload: { workflowId: mission.workflowId, executionId: 'execution-approval', approvalId: 'approval-approval', stepId: 'work' } };
  const persisted = await sink.recordWorkerEvent(mission, event);
  assert.equal(persisted.id, event.eventId);
  assert.equal(persisted.type, 'workflow.approval.required');
  assert.equal(persisted.data.executionId, 'execution-approval');
  assert.equal(persisted.data.approvalId, 'approval-approval');
  assert.equal(events.findByAggregateId(mission.workflowId)[0].id, event.eventId);
  const replayed = await sink.recordWorkerEvent(mission, event);
  assert.equal(replayed.id, persisted.id);
  assert.equal(replayed.sequence, persisted.sequence);
  await assert.rejects(
    () => sink.recordWorkerEvent(mission, { ...event, payload: { ...event.payload, approvalId: 'different-approval' } }),
    error => error.code === 'MISSION_EVENT_ID_CONFLICT'
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sink waits for asynchronous event commit before snapshot persistence', async () => {
  const mission = instance();
  const order = [];
  const sink = new DurableMissionEventSink({
    eventRepository: {
      async appendMissionEvent(event) {
        await new Promise(resolve => setImmediate(resolve));
        order.push('event-committed');
        return { ...event, sequence: 1 };
      },
      async findByAggregateId() { return []; }
    },
    workflowRepository: { async save() { order.push('snapshot-saved'); } }
  });
  await sink.recordState(mission, 'CREATED', 'QUEUED');
  assert.deepEqual(order, ['event-committed', 'snapshot-saved']);
});

test('worker event sink can append without rewriting the workflow snapshot', async () => {
  let snapshotWrites = 0;
  const sink = new DurableMissionEventSink({
    eventRepository: {
      async appendMissionEvent(event) { return { ...event, sequence: 1 }; }
    },
    workflowRepository: { async save() { snapshotWrites += 1; } }
  });
  const mission = instance();
  const persisted = await sink.recordWorkerEvent(mission, {
    eventId: 'worker-state-event-1',
    type: 'workflow.state.changed',
    payload: { workflowId: mission.workflowId, from: 'RUNNING', to: 'WAITING' }
  }, { persist: false });
  assert.equal(persisted.id, 'worker-state-event-1');
  assert.equal(persisted.type, 'workflow.state.changed');
  assert.equal(snapshotWrites, 0);
});

test('JSON durable outbox replays a committed approval event after worker restart exactly once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-outbox-e2e-'));
  const events = new EventRepository(path.join(dir, 'events.json'));
  const workflows = new WorkflowRepository(path.join(dir, 'workflows.json'));
  const sink = new DurableMissionEventSink({ eventRepository: events, workflowRepository: workflows, tenantId: 'local' });
  const mission = instance();
  mission.transition('QUEUED');
  mission.transition('RUNNING');
  let leaseCalls = 0;
  let crashAfterWaitingCommit = true;
  const scheduler = {
    tenantId: 'local',
    leaseDurationMs: 5000,
    workflowRepository: workflows,
    async persistAsync(value) { return workflows.save(value, 'local'); },
    async leaseAsync() {
      leaseCalls += 1;
      return leaseCalls === 1
        ? { instance: mission, leaseId: 'lease-json-outbox', workerId: 'worker-json-outbox', fencingToken: 1, previousState: 'QUEUED', cancelled: false }
        : null;
    },
    async renewAsync() {},
    async assertCurrentAsync() {},
    async releaseAsync() {}
  };
  const eventSink = async (event, workflow, options) => {
    const receipt = await sink.recordWorkerEvent(workflow, event, options);
    if (event.type === 'workflow.state.changed' && event.payload.to === 'WAITING' && crashAfterWaitingCommit) {
      crashAfterWaitingCommit = false;
      throw new Error('simulated crash after JSON event commit');
    }
    return receipt;
  };
  const executor = async () => {
    throw Object.assign(new Error('approval required'), {
      code: 'APPROVAL_REQUIRED',
      executionContext: { executionId: 'execution-json-outbox', approvalId: 'approval-json-outbox' }
    });
  };

  try {
    const firstWorker = new AsyncWorkflowWorker({ scheduler, workerId: 'worker-json-outbox', eventSink, executor });
    await assert.rejects(firstWorker.tick(), /simulated crash after JSON event commit/);
    const paused = workflows.findById(mission.workflowId, 'local');
    assert.equal(paused.state, 'WAITING');
    assert.equal(paused.metadata.pendingPublications.length, 2);

    const restartedWorker = new AsyncWorkflowWorker({ scheduler, workerId: 'worker-json-outbox-restarted', eventSink, executor });
    assert.equal(await restartedWorker.tick(), null);

    const persistedEvents = events.findByAggregateId(mission.workflowId, { tenantId: 'local' });
    assert.equal(persistedEvents.filter(event => event.type === 'workflow.state.changed' && event.data.to === 'WAITING').length, 1);
    assert.equal(persistedEvents.filter(event => event.type === 'workflow.approval.required').length, 1);
    const acknowledged = workflows.findById(mission.workflowId, 'local');
    assert.deepEqual(acknowledged.metadata.pendingPublications, []);
    assert.equal(acknowledged.checkpoint.revision, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
