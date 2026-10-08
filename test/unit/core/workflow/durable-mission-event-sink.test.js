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

test('canonical event sink persists event before snapshot projection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-step37-'));
  const events = new EventRepository(path.join(dir, 'events.json'));
  const workflows = new WorkflowRepository(path.join(dir, 'workflows.json'));
  const sink = new DurableMissionEventSink({ eventRepository: events, workflowRepository: workflows });

  const mission = instance();
  sink.recordCreated(mission);
  sink.recordState(mission, 'CREATED', 'QUEUED');

  const stored = events.findByAggregateId(mission.workflowId);
  assert.deepEqual(stored.map(e => [e.sequence, e.type]), [
    [1, 'workflow.created'],
    [2, 'workflow.state.changed']
  ]);
  assert.equal(workflows.findById(mission.workflowId).state, 'QUEUED');

  workflows.save(mission);
  const restored = sink.reconstruct(mission.workflowId);
  assert.equal(restored.state, 'QUEUED');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('event survives crash between event append and workflow snapshot persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-step37-crash-'));
  const events = new EventRepository(path.join(dir, 'events.json'));
  const failingWorkflowRepository = { save() { throw Object.assign(new Error('simulated crash'), { code: 'SIMULATED_CRASH' }); } };
  const sink = new DurableMissionEventSink({ eventRepository: events, workflowRepository: failingWorkflowRepository });

  const mission = instance();
  sink.recordCreated(mission);
  assert.throws(
    () => sink.recordState(mission, 'CREATED', 'QUEUED'),
    error => error.code === 'SIMULATED_CRASH' && error.missionEventSequence === 2
  );

  const restored = sink.reconstruct(mission.workflowId);
  assert.equal(restored.state, 'QUEUED');
  assert.equal(restored.metadata.projection.lastSequence, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('event persistence failure is classified as a mission durability failure', () => {
  const sink = new DurableMissionEventSink({
    eventRepository: { appendMissionEvent() { throw new Error('disk unavailable'); } }
  });
  const mission = instance();
  assert.throws(
    () => sink.recordCreated(mission),
    error => error.code === 'MISSION_EVENT_PERSISTENCE_FAILED'
  );
});
