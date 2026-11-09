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
    () => sink.recordState(mission, 'CREATED', 'QUEUED'),
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
    () => sink.recordCreated(mission),
    error => error.code === 'MISSION_EVENT_PERSISTENCE_FAILED'
  );
});


test('async event append completes before the lease-scoped workflow snapshot write', async () => {
  const order = [];
  const workerPrincipal = { tenantId: 'local', workerId: 'worker-a', sessionId: 'session-a' };
  const sink = new DurableMissionEventSink({
    eventRepository: {
      async appendMissionEvent(event) {
        await Promise.resolve();
        order.push('event');
        return { ...event, sequence: 1 };
      }
    },
    workflowRepository: {
      async save(_instance, _tenantId, options) {
        assert.equal(options.workerPrincipal, workerPrincipal);
        order.push('snapshot');
      }
    }
  });
  const mission = instance();
  await sink.recordWorkerEvent(mission, {
    type: 'workflow.state.changed',
    timestamp: '2026-11-09T10:00:00.000Z',
    payload: { from: 'QUEUED', to: 'RUNNING' },
    workerPrincipal
  });
  assert.deepEqual(order, ['event', 'snapshot']);
});


test('worker mission events preserve their stable identity and lease principal', async () => {
  const workerPrincipal = { tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'session-a' };
  const event = {
    eventId: 'worker-event-stable-1',
    type: 'workflow.state.changed',
    timestamp: '2026-11-09T11:00:00.000Z',
    payload: { from: 'QUEUED', to: 'RUNNING' },
    workerPrincipal
  };
  let persistedEvent;
  let persistedOptions;
  const sink = new DurableMissionEventSink({
    eventRepository: {
      async appendMissionEvent(value, options) {
        persistedEvent = value;
        persistedOptions = options;
        return { ...value, sequence: 1 };
      }
    }
  });
  await sink.recordWorkerEvent(instance(), event);
  assert.equal(persistedEvent.id, event.eventId);
  assert.equal(persistedEvent.timestamp, event.timestamp);
  assert.strictEqual(persistedOptions.workerPrincipal, workerPrincipal);
  assert.equal(persistedOptions.tenantId, 'local');
});
