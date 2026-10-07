const crypto = require('crypto');
const lifecyclePolicy = require('./agent-lifecycle-policy');

const LIFECYCLE = Object.freeze({
  CREATED: 'created',
  UNDERSTANDING: 'understanding',
  PLANNING: 'planning',
  VALIDATING: 'validating',
  EXECUTING: 'executing',
  OBSERVING: 'observing',
  EVALUATING: 'evaluating',
  RECOVERING: 'recovering',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

class AgentState {
  constructor({ agentId = 'default-agent', goalId } = {}) {
    if (!goalId) {
      throw new Error('goalId is required');
    }

    this.agentId = agentId;
    this.executionId = crypto.randomUUID();
    this.goalId = goalId;
    this.lifecycle = LIFECYCLE.CREATED;
    this.currentPlan = null;
    this.currentStep = null;
    this.observations = [];
    this.decisions = [];
    this.errors = [];
    this.metrics = {};
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
  }

  transitionTo(state) {
    if (!Object.values(LIFECYCLE).includes(state)) {
      throw new Error('Invalid agent lifecycle');
    }

    lifecyclePolicy.assertTransition(this.lifecycle, state);
    this.lifecycle = state;
    this.updatedAt = new Date().toISOString();
    return this;
  }

  canTransitionTo(state) {
    return Object.values(LIFECYCLE).includes(state)
      && lifecyclePolicy.canTransition(this.lifecycle, state);
  }

  toJSON() {
    return {
      agentId: this.agentId,
      executionId: this.executionId,
      goalId: this.goalId,
      lifecycle: this.lifecycle,
      currentPlan: this.currentPlan,
      currentStep: this.currentStep,
      observations: this.observations,
      decisions: this.decisions,
      errors: this.errors,
      metrics: this.metrics,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

AgentState.LIFECYCLE = LIFECYCLE;
AgentState.LIFECYCLE_TRANSITIONS = lifecyclePolicy.LIFECYCLE_TRANSITIONS;

module.exports = AgentState;
