const test = require('node:test');
const assert = require('node:assert/strict');

const ExecutionContext = require('../../../../src/core/execution/execution-context');
const Goal = require('../../../../src/core/goal/goal.entity');

test('ExecutionContext owns a first-class Goal and mirrors terminal lifecycle', () => {
  const context = new ExecutionContext({
    requestId: 'goal-context-1',
    input: 'save a user fact',
    executionId: 'execution-goal-1'
  });

  assert.equal(context.goalId, context.goal.id);
  assert.equal(context.goal.status, Goal.STATUS.CREATED);

  context.start();
  assert.equal(context.goal.status, Goal.STATUS.RUNNING);

  context.complete();
  assert.equal(context.goal.status, Goal.STATUS.COMPLETED);

  const snapshot = context.snapshot();
  assert.equal(snapshot.goal.id, context.goalId);
  assert.equal(snapshot.goal.status, Goal.STATUS.COMPLETED);
  assert.ok(snapshot.events.some(event => event.type === 'goal.started'));
  assert.ok(snapshot.events.some(event => event.type === 'goal.completed'));
});

test('ExecutionContext restore preserves Goal lifecycle', () => {
  const context = new ExecutionContext({
    requestId: 'goal-context-2',
    input: 'remember this',
    executionId: 'execution-goal-2'
  });
  context.start();
  context.complete();

  const restored = ExecutionContext.restore(context.snapshot());

  assert.equal(restored.goal.id, context.goal.id);
  assert.equal(restored.goal.status, Goal.STATUS.COMPLETED);
  assert.equal(restored.goal.executionId, context.executionId);
});
