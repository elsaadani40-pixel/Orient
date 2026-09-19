const crypto = require('crypto');

const ExecutionContext =
  require('../execution/execution-context');

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

    this.name = 'ORIENT_RUNTIME';
    this.version = '0.3.0';
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

    try {
      const plan = this.planner.plan(text);

      context.setPlan(plan);

      if (!plan.tool) {
        context.fail(
          new Error('No suitable tool found')
        );

        return {
          requestId,
          type: 'response',
          message:
            'ORIENT ONE فهم الطلب، لكن لا توجد أداة مناسبة لتنفيذه حاليًا.',
          execution: context.snapshot()
        };
      }

      if (!this.toolRegistry.has(plan.tool)) {
        const error =
          new Error(`Tool not registered: ${plan.tool}`);

        error.code = 'TOOL_NOT_REGISTERED';

        context.fail(error);

        return {
          requestId,
          type: 'error',
          message: 'الأداة المطلوبة غير مسجلة.',
          execution: context.snapshot()
        };
      }

      context.setTool(plan.tool);

      const result =
        await this.toolRegistry.execute(
          plan.tool,
          plan.input,
          {
            requestId,
            executionId: context.executionId,
            input: text,
            plan
          }
        );

      context.setResult(result);
      context.complete();

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
        execution: context.snapshot()
      };
    } catch (error) {
      context.fail(error);

      throw error;
    }
  }

  resolveResponseType(intent) {
    if (intent.startsWith('memory.')) {
      return 'memory_result';
    }

    return 'tool_result';
  }
}

module.exports = OrientRuntime;
