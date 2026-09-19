const crypto = require('crypto');

const ExecutionContext =
  require('../execution/execution-context');

const AgentLoop =
  require('../execution/agent-loop');

const PlanValidator =
  require('../planning/validation/plan-validator');

class OrientRuntime {
  constructor({ toolRegistry, planner }) {
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }

    if (!planner) {
      throw new TypeError('planner is required');
    }

    this.toolRegistry = toolRegistry;
    this.planner = planner;

    this.planValidator =
      new PlanValidator({
        maxSteps: 5
      });

    this.agentLoop =
      new AgentLoop({
        toolRegistry
      });

    this.name = 'ORIENT_RUNTIME';
    this.version = '0.7.0';
  }

  async execute(input) {
    const requestId = crypto.randomUUID();
    const text = String(input || '').trim();

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

    context.record('request.understood', {
      inputLength: text.length
    });

    try {
      const planned =
        this.planner.plan(text);

      context.record('plan.generated', {
        intent: planned.intent,
        confidence: planned.confidence
      });

      const validation =
        this.planValidator.validate(planned);

      context.record('plan.validation.completed', {
        valid: validation.valid,
        steps: validation.steps.length
      });

      const plan = {
        ...planned,
        steps: validation.steps
      };

      context.setPlan(plan);

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

      context.complete();

      const result =
        loopResult.result;

      return {
        requestId,
        type: this.resolveResponseType(plan.intent),
        query:
          plan.intent === 'memory.search'
            ? plan.input
            : '',
        count:
          result &&
          Array.isArray(result.memories)
            ? result.memories.length
            : undefined,
        result,
        evaluation: loopResult.evaluation,
        execution: context.snapshot()
      };
    } catch (error) {
      context.fail(error);

      throw error;
    }
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

module.exports = OrientRuntime;
