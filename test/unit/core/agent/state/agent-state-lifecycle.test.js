const test = require('node:test');
const assert = require('node:assert/strict');
const AgentState = require('../../../../../src/core/agent/state/agent-state');

test('AgentState enforces the agent lifecycle transition contract', () => {
  const state = new AgentState({ goalId: 'goal-1' });

  assert.equal(state.canTransitionTo(AgentState.LIFECYCLE.UNDERSTANDING), true);
  state.transitionTo(AgentState.LIFECYCLE.UNDERSTANDING);
  state.transitionTo(AgentState.LIFECYCLE.PLANNING);
  state.transitionTo(AgentState.LIFECYCLE.VALIDATING);
  state.transitionTo(AgentState.LIFECYCLE.EXECUTING);
  state.transitionTo(AgentState.LIFECYCLE.OBSERVING);
  state.transitionTo(AgentState.LIFECYCLE.EVALUATING);
  state.transitionTo(AgentState.LIFECYCLE.COMPLETED);

  assert.equal(state.lifecycle, AgentState.LIFECYCLE.COMPLETED);
  assert.throws(
    () => state.transitionTo(AgentState.LIFECYCLE.EXECUTING),
    (error) => error.code === 'AGENT_INVALID_LIFECYCLE_TRANSITION'
  );
});

test('AgentState permits bounded recovery and resume without conflating lifecycle states', () => {
  const state = new AgentState({ goalId: 'goal-2' });

  state.transitionTo(AgentState.LIFECYCLE.UNDERSTANDING);
  state.transitionTo(AgentState.LIFECYCLE.PLANNING);
  state.transitionTo(AgentState.LIFECYCLE.VALIDATING);
  state.transitionTo(AgentState.LIFECYCLE.EXECUTING);
  state.transitionTo(AgentState.LIFECYCLE.RECOVERING);
  state.transitionTo(AgentState.LIFECYCLE.EXECUTING);
  state.transitionTo(AgentState.LIFECYCLE.WAITING);
  state.transitionTo(AgentState.LIFECYCLE.EXECUTING);

  assert.equal(state.lifecycle, AgentState.LIFECYCLE.EXECUTING);
});

test('terminal agent lifecycle states cannot transition', () => {
  for (const terminal of [
    AgentState.LIFECYCLE.COMPLETED,
    AgentState.LIFECYCLE.CANCELLED
  ]) {
    const state = new AgentState({ goalId: 'terminal-' + terminal });
    state.lifecycle = terminal;
    assert.equal(state.canTransitionTo(AgentState.LIFECYCLE.EXECUTING), false);
    assert.throws(
      () => state.transitionTo(AgentState.LIFECYCLE.EXECUTING),
      (error) => error.code === 'AGENT_INVALID_LIFECYCLE_TRANSITION'
    );
  }
});
