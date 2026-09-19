const OBSERVATION_EVENTS = require('../observation/observation-events');

class AgentOrchestrator {
  constructor({
    planner,
    decisionEngine,
    recoveryEngine,
    eventPublisher = null
  } = {}) {
    if (!planner) {
      throw new TypeError('planner is required');
    }

    if (!decisionEngine) {
      throw new TypeError('decisionEngine is required');
    }

    if (!recoveryEngine) {
      throw new TypeError('recoveryEngine is required');
    }

    this.planner = planner;
    this.decisionEngine = decisionEngine;
    this.recoveryEngine = recoveryEngine;
    this.eventPublisher = eventPublisher;
  }

  async publishEvent({
    type,
    executionId = null,
    goalId = null,
    data = {}
  } = {}) {
    if (!this.eventPublisher) {
      return null;
    }

    return this.eventPublisher.publish({
      type,
      executionId,
      goalId,
      data
    });
  }

  async plan(input, context = {}) {
    const plan = await this.planner.plan(input);

    await this.publishEvent({
      type: OBSERVATION_EVENTS.PLAN_CREATED,
      executionId: context.executionId || null,
      goalId: context.goalId || null,
      data: {
        input,
        plan
      }
    });

    return plan;
  }

  async decide(evaluation, context = {}) {
    const decision = this.decisionEngine.decide(evaluation);

    await this.publishEvent({
      type: OBSERVATION_EVENTS.DECISION_CREATED,
      executionId: context.executionId || null,
      goalId: context.goalId || null,
      data: {
        evaluation,
        decision
      }
    });

    return decision;
  }

  async recover(error, context = {}) {
    const recovery = this.recoveryEngine.recover(error);

    await this.publishEvent({
      type: OBSERVATION_EVENTS.RECOVERY_STARTED,
      executionId: context.executionId || null,
      goalId: context.goalId || null,
      data: {
        error: {
          name: error?.name || 'Error',
          message: error?.message || String(error || ''),
          code: error?.code || null
        },
        recovery
      }
    });

    return recovery;
  }
}

module.exports = AgentOrchestrator;
