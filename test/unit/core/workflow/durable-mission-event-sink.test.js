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
const { createPersistencePrincipal } = require('../../../../src/core/security/persistence-principal');

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


test('owner principal is propagated to both mission event append and snapshot persistence', async () => {
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a'
  });
  const calls = [];
  const sink = new DurableMissionEventSink({
    eventRepository: {
      async appendMissionEvent(event, options) {
        calls.push(['event', options.persistencePrincipal]);
        return { ...event, sequence: 1 };
      }
    },
    workflowRepository: {
      async save(_instance, tenantId, options) {
        calls.push(['snapshot', tenantId, options.persistencePrincipal]);
      }
    },
    tenantId: 'tenant-a'
  });
  const mission = instance();
  mission.userId = 'owner-a';
  await sink.recordSnapshot(mission, 'approval_resolution', {
    persistencePrincipal: principal
  });
  assert.strictEqual(calls[0][1], principal);
  assert.equal(calls[1][1], 'tenant-a');
  assert.strictEqual(calls[1][2], principal);
});
