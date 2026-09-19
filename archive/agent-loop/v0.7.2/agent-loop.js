const AppError = require('../errors/AppError');

class AgentLoop {
  constructor({ toolRegistry }) {
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }

    this.toolRegistry = toolRegistry;
    this.name = 'ORIENT_AGENT_LOOP';
    this.version = '0.5.0';

    this.maxSteps = 5;
  }

  async run({
    plan,
    context,
    runtimeContext = {}
  }) {
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

    const steps = this.normalizeSteps(plan);

    if (steps.length === 0) {
      const evaluation = {
        outcome: 'no_action',
        nextAction: null,
        reason: 'لا توجد خطوات قابلة للتنفيذ'
      };

      context.record(
        'evaluation.completed',
        evaluation
      );

      return {
        status: 'no_action',
        result: null,
        evaluation,
        stepsExecuted: 0
      };
    }

    const executedTools = new Set();
    let lastResult = null;
    let lastEvaluation = null;

    for (
      let index = 0;
      index < steps.length;
      index += 1
    ) {
      const stepNumber = index + 1;
      const step = steps[index];

      if (stepNumber > this.maxSteps) {
        const error = new AppError(
          'تم تجاوز الحد الأقصى لخطوات التنفيذ',
          500,
          'MAX_EXECUTION_STEPS_EXCEEDED'
        );

        context.record(
          'execution.stopped',
          {
            reason: 'max_steps',
            maxSteps: this.maxSteps
          }
        );

        throw error;
      }

      if (!step.tool) {
        context.record(
          'execution.step.skipped',
          {
            step: stepNumber,
            reason: 'لا توجد أداة'
          }
        );

        continue;
      }

      if (executedTools.has(step.tool)) {
        const error = new AppError(
          `تم منع تكرار الأداة "${step.tool}"`,
          500,
          'EXECUTION_LOOP_DETECTED'
        );

        context.record(
          'execution.loop_detected',
          {
            step: stepNumber,
            tool: step.tool
          }
        );

        throw error;
      }

      if (!this.toolRegistry.has(step.tool)) {
        const error = new AppError(
          `الأداة "${step.tool}" غير مسجلة`,
          500,
          'TOOL_NOT_REGISTERED'
        );

        context.record(
          'authorization.failed',
          {
            step: stepNumber,
            tool: step.tool
          }
        );

        throw error;
      }

      context.record(
        'authorization.completed',
        {
          step: stepNumber,
          tool: step.tool,
          authorized: true
        }
      );

      context.setTool(step.tool);

      context.startStep({
        step: stepNumber,
        tool: step.tool
      });

      executedTools.add(step.tool);

      try {
        const result =
          await this.toolRegistry.execute(
            step.tool,
            step.input,
            {
              ...runtimeContext,

              executionId:
                context.executionId,

              requestId:
                context.requestId,

              tool: step.tool,

              step: stepNumber,

              previousResult:
                lastResult
            }
          );

        context.completeStep({
          step: stepNumber,
          tool: step.tool,
          result
        });

        context.addObservation({
          step: stepNumber,
          tool: step.tool,
          success: true,
          result
        });

        const evaluation =
          this.evaluate({
            plan,
            step,
            result,
            stepNumber
          });

        context.record(
          'evaluation.completed',
          {
            ...evaluation,
            step: stepNumber,
            tool: step.tool
          }
        );

        lastResult = result;
        lastEvaluation = evaluation;

        if (evaluation.outcome === 'failed') {
          return {
            status: 'failed',
            result,
            evaluation,
            stepsExecuted: stepNumber
          };
        }

        if (
          evaluation.outcome === 'done' &&
          index === steps.length - 1
        ) {
          return {
            status: 'done',
            result,
            evaluation,
            stepsExecuted: stepNumber
          };
        }
      } catch (error) {
        context.failStep({
          step: stepNumber,
          tool: step.tool,
          error
        });

        context.addObservation({
          step: stepNumber,
          tool: step.tool,
          success: false,
          error: {
            code:
              error.code ||
              'TOOL_EXECUTION_FAILED',
            message: error.message
          }
        });

        throw error;
      }
    }

    return {
      status:
        lastEvaluation
          ? lastEvaluation.outcome
          : 'done',

      result: lastResult,

      evaluation:
        lastEvaluation || {
          outcome: 'done',
          nextAction: null,
          reason: 'اكتملت خطوات التنفيذ'
        },

      stepsExecuted:
        context.steps.length
    };
  }

  normalizeSteps(plan) {
    if (
      Array.isArray(plan.steps)
    ) {
      return plan.steps
        .filter(
          (step) =>
            step &&
            typeof step === 'object'
        )
        .map((step) => ({
          tool: step.tool || null,
          input:
            step.input === undefined
              ? null
              : step.input
        }));
    }

    if (plan.tool) {
      return [
        {
          tool: plan.tool,
          input:
            plan.input === undefined
              ? null
              : plan.input
        }
      ];
    }

    return [];
  }

  evaluate({
    plan,
    step,
    result,
    stepNumber
  }) {
    if (result === undefined) {
      return {
        outcome: 'failed',
        nextAction: null,
        reason:
          `الخطوة ${stepNumber} لم تُرجع نتيجة`
      };
    }

    const hasNextStep =
      Array.isArray(plan.steps) &&
      stepNumber < plan.steps.length;

    return {
      outcome:
        hasNextStep
          ? 'continue'
          : 'done',

      nextAction:
        hasNextStep
          ? 'next_step'
          : null,

      reason:
        hasNextStep
          ? `تم تنفيذ ${step.tool} بنجاح، الانتقال للخطوة التالية`
          : `تم تنفيذ ${step.tool} بنجاح`
    };
  }
}

module.exports = AgentLoop;
