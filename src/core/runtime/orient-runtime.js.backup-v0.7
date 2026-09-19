const crypto = require('crypto');

const ExecutionContext =
  require('../execution/execution-context');

const AgentLoop =
  require('../execution/agent-loop');

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

    this.agentLoop =
      new AgentLoop({
        toolRegistry
      });

    this.name = 'ORIENT_RUNTIME';
    this.version = '0.4.0';
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
      const plan =
        this.planner.plan(text);

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
