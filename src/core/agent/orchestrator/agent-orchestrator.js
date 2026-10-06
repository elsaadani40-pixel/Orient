const OBSERVATION_EVENTS =
  require('../observation/observation-events');

class AgentOrchestrator {
  constructor({
    planner,
    planValidator,
    replanner,
    decisionEngine,
    recoveryEngine,
    eventPublisher = null,
    modelRouter = null
  } = {}) {
    if (!planner) {
      throw new TypeError('planner is required');
    }

    if (!planValidator) {
      throw new TypeError('planValidator is required');
    }

    if (!replanner) {
      throw new TypeError('replanner is required');
    }

    if (!decisionEngine) {
      throw new TypeError('decisionEngine is required');
    }

    if (!recoveryEngine) {
      throw new TypeError('recoveryEngine is required');
    }

    this.planner = planner;
    this.planValidator = planValidator;
    this.replanner = replanner;
    this.decisionEngine = decisionEngine;
    this.recoveryEngine = recoveryEngine;
    this.eventPublisher = eventPublisher;
    this.modelRouter = modelRouter;
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
    const planned = await this.planner.plan(input, {
      modelRouter: this.modelRouter,
      context
    });

    const validation =
      this.planValidator.validate(planned);

    const plan = {
      ...planned,
      steps: validation.steps
    };

    await this.publishEvent({
      type: OBSERVATION_EVENTS.PLAN_CREATED,
      executionId: context.executionId || null,
      goalId: context.goalId || null,
      data: {
        input,
        plan,
        agentId: plan.agentId || null,
        validation: {
          valid: validation.valid,
          steps: validation.steps.length
        },
        routing: planned.routing || null
      }
    });

    return {
      plan,
      validation
    };
  }

  async completeModel(request = {}, context = {}) {
    if (!this.modelRouter) {
      throw Object.assign(
        new Error('Model router is not configured'),
        { code: 'MODEL_ROUTER_REQUIRED' }
      );
    }

    const result = await this.modelRouter.complete(request);

    await this.publishEvent({
      type: 'model.routing.completed',
      executionId: context.executionId || null,
      goalId: context.goalId || null,
      data: {
        routing: result.routing || null
      }
    });

    return result;
  }

  async replan({
    input,
    evaluation = null,
    previousPlan = null,
    context = {}
  } = {}) {
    const planned =
      await this.planner.replan({
        input,
        evaluation,
        previousPlan,
        context
      });

    if (!planned) {
      return null;
    }

    const validation =
      this.planValidator.validate(planned);

    const plan = {
      ...planned,
      steps: validation.steps
    };

    await this.publishEvent({
      type: OBSERVATION_EVENTS.PLAN_CREATED,
      executionId: context.executionId || null,
      goalId: context.goalId || null,
      data: {
        input,
        replan: true,
        plan,
        validation: {
          valid: validation.valid,
          steps: validation.steps.length
        }
      }
    });

    return {
      plan,
      validation
    };
  }

  decide(evaluation, context = {}) {
    const decision = this.decisionEngine.decide(evaluation);

    if (this.eventPublisher) {
      this.publishEvent({
        type: OBSERVATION_EVENTS.DECISION_CREATED,
        executionId: context.executionId || null,
        goalId: context.goalId || null,
        data: { evaluation, decision }
      }).catch(() => {});
    }

    return decision;
  }

  decideReplanning({
    evaluation,
    replans = 0,
    hasRemainingSteps = false,
    context = {}
  } = {}) {
    const decision =
      this.replanner.decide({
        evaluation,
        replans,
        hasRemainingSteps
      });

    return decision;
  }

  async recover(error, context = {}) {
    const recovery =
      this.recoveryEngine.recover(error);

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
