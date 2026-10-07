const test = require('node:test');
const assert = require('node:assert/strict');

const Goal = require('../../../../src/core/goal/goal.entity');

test('Goal provides a first-class lifecycle with explicit terminal states', () => {
  const goal = new Goal({
    id: 'goal-1',
    input: 'save a fact',
    executionId: 'execution-1',
    tenantId: 'local'
  });

  assert.equal(goal.status, Goal.STATUS.CREATED);
  assert.equal(goal.snapshot().executionId, 'execution-1');

  goal.transitionTo(Goal.STATUS.RUNNING);
  assert.equal(goal.status, Goal.STATUS.RUNNING);
  assert.ok(goal.startedAt);

  goal.transitionTo(Goal.STATUS.COMPLETED);
  assert.equal(goal.status, Goal.STATUS.COMPLETED);
  assert.ok(goal.completedAt);

  assert.throws(
    () => goal.transitionTo(Goal.STATUS.RUNNING),
    /Cannot transition goal/
  );
});

test('Goal rejects invalid input and invalid transitions', () => {
  assert.throws(() => new Goal({ input: '' }), /goal input is required/);

  const goal = new Goal({ input: 'x' });
  assert.throws(() => goal.transitionTo('unknown'), /invalid goal status/);
  assert.throws(() => goal.transitionTo(Goal.STATUS.COMPLETED), /Cannot transition goal/);
});
