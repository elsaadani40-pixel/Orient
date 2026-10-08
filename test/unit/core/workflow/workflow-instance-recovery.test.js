const test = require('node:test');
const assert = require('node:assert/strict');

const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');

function instance() {
  const definition = new WorkflowDefinition({
    id: 'mission-recovery',
    name: 'Mission Recovery',
    steps: [
      { id: 'done', tool: 'a' },
      { id: 'running', tool: 'b', dependsOn: ['done'] }
    ]
  });
  return new WorkflowInstance({ definition });
}

test('lease-loss recovery preserves completed work and requeues only in-flight steps', () => {
  const mission = instance();
  mission.markStepRunning('done');
  mission.markStepCompleted('done', { ok: true });
  mission.markStepRunning('running');
  mission.transition('RUNNING');
  mission.metadata.fencingToken = 7;

  mission.recoverFromLeaseLoss('WORKER_CRASH');

  assert.equal(mission.state, 'RECOVERING');
  assert.equal(mission.steps.done.state, 'COMPLETED');
  assert.equal(mission.steps.done.result.ok, true);
  assert.equal(mission.steps.running.state, 'PENDING');
  assert.equal(mission.recovery.count, 1);
  assert.equal(mission.recovery.lastReason, 'WORKER_CRASH');
  assert.equal(mission.metadata.fencingToken, undefined);
});

test('recovery state survives durable JSON round trip', () => {
  const mission = instance();
  mission.transition('QUEUED');
  mission.transition('RUNNING');
  mission.recoverFromLeaseLoss();
  mission.setCheckpointRevision(4, '2026-10-08T00:00:00.000Z');

  const restored = WorkflowInstance.fromJSON(mission.toJSON());

  assert.equal(restored.state, 'RECOVERING');
  assert.equal(restored.recovery.count, 1);
  assert.equal(restored.checkpoint.revision, 4);
  assert.equal(restored.checkpoint.lastSavedAt, '2026-10-08T00:00:00.000Z');
});
