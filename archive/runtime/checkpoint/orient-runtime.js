const crypto = require('crypto');

const ExecutionContext =
  require('../execution/execution-context');

const AgentState =
  require('../agent/state/agent-state');

const AgentLoop =
  require('../execution/agent-loop');

const PlanValidator =
  require('../planning/validation/plan-validator');

const Replanner =
  require('../planning/replanning/replanner');

class OrientRuntime {
  constructor({
    toolRegistry,
    planner,
    authorizationService = null,
    recoveryEngine = null,
    persistence = null
  }) {
    if (!toolRegistry) {
      throw new TypeError(
        'toolRegistry is required'
      );
    }

    if (!planner) {
      throw new TypeError(
        'planner is required'
      );
    }

    this.toolRegistry =
      toolRegistry;

    this.planner =
      planner;

    this.authorizationService =
      authorizationService;

    this.recoveryEngine =
      recoveryEngine;

    this.persistence =
      persistence;

    this.planValidator =
      new PlanValidator({
        maxSteps: 5
      });

    this.agentLoop =
      new AgentLoop({
        toolRegistry,
        authorizationService,
        idempotencyRepository:
          persistence?.idempotency || null
      });

    this.replanner =
      new Replanner({
        maxReplans: 3
      });

    this.name =
      'ORIENT_RUNTIME';

    this.version =
      '0.9.0';
  }

  persistEvents(context) {
    if (
      !this.persistence ||
      !this.persistence.events
    ) {
      return [];
    }

    const events =
      Array.isArray(context.events)
        ? context.events
        : [];

    if (!events.length) {
      return [];
    }

    return this.persistence.events.appendMany(
      events
    );
  }

  persistExecution(context, mode = 'update') {
    if (
      !this.persistence ||
      !this.persistence.executions
    ) {
      return null;
    }

    const snapshot =
      context.snapshot();

    if (mode === 'insert') {
      return this.persistence.executions.insert(
        snapshot
      );
    }

    return this.persistence.executions.update(
      snapshot.executionId,
      snapshot
    );
  }

  async execute(input) {
    const requestId =
      crypto.randomUUID();

    const text =
      String(input || '').trim();

    if (!text) {
      return {
        requestId,
        type: 'error',
        message: 'لم يتم إرسال طلب.'
      };
    }

    const context =
      new ExecutionContext({
        requestId,
        input: text
      });

    context.start();

    context.record(
      'request.understood',
      {
        inputLength:
          text.length
      }
    );

    this.persistExecution(
      context,
      'insert'
    );

    try {
      context.transitionAgentTo(
        AgentState.LIFECYCLE.PLANNING
      );

      const planned =
        await this.planner.plan(
          text
        );

      context.record(
        'plan.generated',
        {
          intent:
            planned.intent,

          confidence:
            planned.confidence
        }
      );

      context.transitionAgentTo(
        AgentState.LIFECYCLE.VALIDATING
      );

      const validation =
        this.planValidator.validate(
          planned
        );

      context.record(
        'plan.validation.completed',
        {
          valid:
            validation.valid,

          steps:
            validation.steps.length
        }
      );

      const plan = {
        ...planned,
        steps:
          validation.steps
      };

      context.setPlan(
        plan
      );

      context.transitionAgentTo(
        AgentState.LIFECYCLE.EXECUTING
      );

      const loopResult =
        await this.agentLoop.run({
          plan,
          context,
          runtimeContext: {
            requestId,
            input: text,
            plan
          }
        });

      context.transitionAgentTo(
        AgentState.LIFECYCLE.OBSERVING
      );

      context.record(
        'observation.phase.completed',
        {
          stepsExecuted:
            loopResult.stepsExecuted,

          observations:
            context.observations.length
        }
      );

      context.transitionAgentTo(
        AgentState.LIFECYCLE.EVALUATING
      );

      const replanningDecision =
        this.replanner.decide({
          evaluation:
            loopResult.evaluation,

          replans:
            0,

          hasRemainingSteps:
            loopResult.stepsExecuted <
            plan.steps.length
        });

      context.record(
        'replanning.decision',
        replanningDecision.toJSON()
      );

      context.complete();

      this.persistExecution(
        context,
        'update'
      );

      this.persistEvents(
        context
      );

      const result =
        loopResult.result;

      return {
        requestId,

        type:
          this.resolveResponseType(
            plan.intent
          ),

        query:
          plan.intent === 'memory.search'
            ? plan.input
            : '',

        count:
          result &&
          Array.isArray(
            result.memories
          )
            ? result.memories.length
            : undefined,

        result,

        evaluation:
          loopResult.evaluation,

        replanning:
          replanningDecision.toJSON(),

        execution:
          context.snapshot()
      };
    } catch (error) {
      if (
        context.isActive() &&
        context.canTransitionAgentTo(
          AgentState.LIFECYCLE.RECOVERING
        )
      ) {
        context.transitionAgentTo(
          AgentState.LIFECYCLE.RECOVERING
        );
      }

      const recovery =
        this.classifyRecovery({
          error,
          context
        });

      context.record(
        'recovery.completed',
        recovery
      );

      context.fail(
        error
      );

      this.persistExecution(
        context,
        'update'
      );

      this.persistEvents(
        context
      );

      throw error;
    }
  }

  classifyRecovery({
    error,
    context
  }) {
    if (!this.recoveryEngine) {
      const fallback = {
        action: 'abort',

        reason:
          'Recovery Engine غير متصل',

        target: null,

        metadata: {
          recoveryAvailable:
            false
        }
      };

      context.record(
        'recovery.started',
        fallback
      );

      return fallback;
    }

    const recovery =
      this.recoveryEngine.recover(
        error
      );

    const serialized =
      typeof recovery.toJSON ===
      'function'
        ? recovery.toJSON()
        : recovery;

    context.record(
      'recovery.started',
      {
        action:
          serialized.action,

        reason:
          serialized.reason,

        target:
          serialized.target,

        metadata:
          serialized.metadata
      }
    );

    return serialized;
  }

  resolveResponseType(intent) {
    if (
      typeof intent === 'string' &&
      intent.startsWith('memory.')
    ) {
      return 'memory_result';
    }

    return 'tool_result';
  }
}

module.exports =
  OrientRuntime;
