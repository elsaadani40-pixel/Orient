const test = require('node:test');
const assert = require('node:assert/strict');
const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');
const MissionEventProjection = require('../../../../src/core/workflow/mission-event-projection');

function definition() {
  return new WorkflowDefinition({
    id: 'mission-projection-v1',
    version: 1,
    name: 'Projection Mission',
    steps: [
      { id: 'prepare', tool: 'prepare' },
      { id: 'finish', tool: 'finish', dependsOn: ['prepare'] }
    ]
  });
}

function stream() {
  const d = definition().toJSON();
  return [
    { id: 'e1', aggregateId: 'wf-36', sequence: 1, type: 'workflow.created', timestamp: '2026-10-08T10:00:00.000Z', data: { workflowId: 'wf-36', tenantId: 'local', definition: d } },
    { id: 'e2', aggregateId: 'wf-36', sequence: 2, type: 'workflow.state.changed', timestamp: '2026-10-08T10:00:01.000Z', data: { to: 'QUEUED' } },
    { id: 'e3', aggregateId: 'wf-36', sequence: 3, type: 'workflow.state.changed', timestamp: '2026-10-08T10:00:02.000Z', data: { to: 'RUNNING' } },
    { id: 'e4', aggregateId: 'wf-36', sequence: 4, type: 'workflow.step.running', timestamp: '2026-10-08T10:00:03.000Z', data: { stepId: 'prepare' } },
    { id: 'e5', aggregateId: 'wf-36', sequence: 5, type: 'workflow.step.completed', timestamp: '2026-10-08T10:00:04.000Z', data: { stepId: 'prepare', result: { ok: true } } },
    { id: 'e6', aggregateId: 'wf-36', sequence: 6, type: 'workflow.checkpoint.saved', timestamp: '2026-10-08T10:00:05.000Z', data: { revision: 6 } }
  ];
}

test('rebuild reconstructs mission state after restart', () => {
  const projection = new MissionEventProjection();
  const restored = projection.rebuild(stream());
  assert.equal(restored.workflowId, 'wf-36');
  assert.equal(restored.state, 'RUNNING');
  assert.equal(restored.steps.prepare.state, 'COMPLETED');
  assert.deepEqual(restored.steps.prepare.result, { ok: true });
  assert.equal(restored.checkpoint.revision, 6);
  assert.equal(restored.metadata.projection.lastSequence, 6);
});

test('duplicate event ids are idempotent during replay', () => {
  const events = stream();
  events.splice(5, 0, { ...events[4] });
  const restored = new MissionEventProjection().rebuild(events);
  assert.equal(restored.steps.prepare.state, 'COMPLETED');
});

test('out-of-order or missing sequence is rejected', () => {
  const events = stream();
  events[4] = { ...events[4], sequence: 7 };
  assert.throws(
    () => new MissionEventProjection().rebuild(events),
    error => error.code === 'MISSION_EVENT_SEQUENCE_GAP'
  );
});

test('invalid transition is rejected during reconstruction', () => {
  const events = stream();
  events[2] = { ...events[2], data: { to: 'COMPLETED' } };
  assert.throws(
    () => new MissionEventProjection().rebuild(events),
    error => error.code === 'WORKFLOW_INVALID_TRANSITION'
  );
});

test('checkpoint regression is rejected', () => {
  const events = stream();
  events.push({
    id: 'e7',
    aggregateId: 'wf-36',
    sequence: 7,
    type: 'workflow.checkpoint.saved',
    timestamp: '2026-10-08T10:00:06.000Z',
    data: { revision: 4 }
  });
  assert.throws(
    () => new MissionEventProjection().rebuild(events),
    error => error.code === 'MISSION_CHECKPOINT_MISMATCH'
  );
});

test('terminal replay remains terminal and rejects later mutation', () => {
  const events = stream();
  events.push(
    { id: 'e7', aggregateId: 'wf-36', sequence: 7, type: 'workflow.state.changed', timestamp: '2026-10-08T10:00:06.000Z', data: { to: 'COMPLETED' } },
    { id: 'e8', aggregateId: 'wf-36', sequence: 8, type: 'workflow.step.running', timestamp: '2026-10-08T10:00:07.000Z', data: { stepId: 'finish' } }
  );
  assert.throws(
    () => new MissionEventProjection().rebuild(events),
    error => error.code === 'WORKFLOW_INVALID_TRANSITION' || error.code === 'WORKFLOW_STEP_NOT_FOUND'
  );
});

test('projection round trip preserves compensation and recovery evidence', () => {
  const events = stream();
  events.push(
    { id: 'e7', aggregateId: 'wf-36', sequence: 7, type: 'workflow.compensation.started', timestamp: '2026-10-08T10:00:06.000Z', data: {} },
    { id: 'e8', aggregateId: 'wf-36', sequence: 8, type: 'workflow.compensation.action', timestamp: '2026-10-08T10:00:07.000Z', data: { action: { id: 'undo-prepare', stepId: 'prepare' } } },
    { id: 'e9', aggregateId: 'wf-36', sequence: 9, type: 'workflow.compensation.completed', timestamp: '2026-10-08T10:00:08.000Z', data: { actionId: 'undo-prepare' } }
  );
  const restored = new MissionEventProjection().rebuild(events);
  assert.equal(restored.compensation.state, 'COMPLETED');
  assert.deepEqual(restored.compensation.completed, ['undo-prepare']);
});
