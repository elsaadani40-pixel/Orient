const AppError = require('../errors/AppError');

class AgentLoop {
  constructor({ toolRegistry }) {
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }

    this.toolRegistry = toolRegistry;
    this.name = 'ORIENT_AGENT_LOOP';
    this.version = '0.4.0';
    this.maxSteps = 1;
  }

  async run({ plan, context, runtimeContext = {} }) {
    if (!plan) {
      throw new AppError(
        'خطة التنفيذ مطلوبة',
        500,
        'PLAN_REQUIRED'
      );
    }

    if (!context) {
      throw new AppError(
        'Execution Context مطلوب',
        500,
        'EXECUTION_CONTEXT_REQUIRED'
      );
    }

    if (!plan.tool) {
      context.record('evaluation.completed', {
        outcome: 'no_action',
        reason: 'لا توجد أداة في الخطة'
      });

      return {
        status: 'no_action',
        result: null
      };
    }

    if (!this.toolRegistry.has(plan.tool)) {
      const error = new AppError(
        `الأداة "${plan.tool}" غير مسجلة`,
        500,
        'TOOL_NOT_REGISTERED'
      );

      context.record('authorization.failed', {
        tool: plan.tool
      });

      throw error;
    }

    context.record('authorization.completed', {
      tool: plan.tool,
      authorized: true
    });

    context.setTool(plan.tool);

    context.record('execution.step.started', {
      step: 1,
      tool: plan.tool
    });

    try {
      const result = await this.toolRegistry.execute(
        plan.tool,
        plan.input,
        {
          ...runtimeContext,
          executionId: context.executionId,
          tool: plan.tool,
          step: 1
        }
      );

      context.record('execution.step.completed', {
        step: 1,
        tool: plan.tool
      });

      context.setResult(result);

      context.record('observation.created', {
        step: 1,
        tool: plan.tool,
        success: true
      });

      const evaluation = this.evaluate({
        plan,
        result
      });

      context.record('evaluation.completed', evaluation);

      return {
        status: evaluation.outcome,
        result,
        evaluation
      };
    } catch (error) {
      context.record('execution.step.failed', {
        step: 1,
        tool: plan.tool,
        code: error.code || 'TOOL_EXECUTION_FAILED'
      });

      context.record('observation.created', {
        step: 1,
        tool: plan.tool,
        success: false
      });

      throw error;
    }
  }

  evaluate({ plan, result }) {
    if (result === undefined) {
      return {
        outcome: 'failed',
        nextAction: null,
        reason: 'الأداة لم تُرجع نتيجة'
      };
    }

    return {
      outcome: 'done',
      nextAction: null,
      reason: `تم تنفيذ ${plan.tool} بنجاح`
    };
  }
}

module.exports = AgentLoop;
