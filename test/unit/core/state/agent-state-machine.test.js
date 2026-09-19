const test = require('node:test');
const assert = require('node:assert/strict');

const AgentState = require('../../../../src/core/agent/state/agent-state');
const AgentStateMachine = require('../../../../src/core/agent/state/agent-state-machine');

const L = AgentState.LIFECYCLE;

function createMachine() {
  const state = new AgentState({
    agentId: 'test-agent',
    goalId: 'test-goal'
  });

  return new AgentStateMachine(state);
}

test('valid lifecycle follows the canonical execution path', () => {
  const machine = createMachine();

  const path = [
    L.UNDERSTANDING,
    L.PLANNING,
    L.VALIDATING,
    L.EXECUTING,
    L.OBSERVING,
    L.EVALUATING,
    L.COMPLETED
  ];

  for (const state of path) {
    assert.equal(machine.canTransitionTo(state), true);
    machine.transitionTo(state);
    assert.equal(machine.getState(), state);
  }
});

test('invalid lifecycle value is rejected', () => {
  const machine = createMachine();

  assert.throws(
    () => machine.transitionTo('not-a-real-state'),
    /Invalid agent lifecycle/
  );
});

test('invalid lifecycle transition is rejected', () => {
  const machine = createMachine();

  assert.equal(machine.canTransitionTo(L.COMPLETED), false);

  assert.throws(
    () => machine.transitionTo(L.COMPLETED),
    /Invalid agent lifecycle transition/
  );
});

test('terminal state cannot transition further', () => {
  const machine = createMachine();

  machine.transitionTo(L.UNDERSTANDING);
  machine.transitionTo(L.PLANNING);
  machine.transitionTo(L.VALIDATING);
  machine.transitionTo(L.EXECUTING);
  machine.transitionTo(L.OBSERVING);
  machine.transitionTo(L.EVALUATING);
  machine.transitionTo(L.COMPLETED);

  assert.equal(machine.canTransitionTo(L.PLANNING), false);

  assert.throws(
    () => machine.transitionTo(L.PLANNING),
    /Invalid agent lifecycle transition/
  );
});

test('recovery path can return to planning', () => {
  const machine = createMachine();

  machine.transitionTo(L.UNDERSTANDING);
  machine.transitionTo(L.PLANNING);
  machine.transitionTo(L.VALIDATING);
  machine.transitionTo(L.EXECUTING);
  machine.transitionTo(L.OBSERVING);
  machine.transitionTo(L.EVALUATING);

  assert.equal(machine.canTransitionTo(L.RECOVERING), true);

  machine.transitionTo(L.RECOVERING);

  assert.equal(machine.canTransitionTo(L.PLANNING), true);

  machine.transitionTo(L.PLANNING);

  assert.equal(machine.getState(), L.PLANNING);
});
