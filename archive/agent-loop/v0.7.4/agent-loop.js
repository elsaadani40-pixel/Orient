const AppError = require('../errors/AppError');

class AgentLoop {
  constructor({ toolRegistry }) {
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }

    this.toolRegistry = toolRegistry;
    this.name = 'ORIENT_AGENT_LOOP';
    this.version = '0.7.3';

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
        stepsExecuted: 0,
        stepResults: []
      };
    }

    this.validateDependencies(steps);

    const executedTools = new Set();
    const completedSteps = new Set();
    const stepResults = [];

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

      this.enforceDependency({
        step,
        stepNumber,
        completedSteps,
        context
      });

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

      const injectedContext =
        this.buildStepContext({
          plan,
          context,
          runtimeContext,
          step,
          stepNumber,
          previousResult: lastResult,
          stepResults
        });

      context.record(
        'context.injected',
        {
          step: stepNumber,
          tool: step.tool,
          previousSteps: stepResults.length,
          dependsOn: step.dependsOn
        }
      );

      context.record(
        'authorization.completed',
        {
          step: stepNumber,
          tool: step.tool,
          authorized: true
        }
      );

      context.startStep({
        step: stepNumber,
        tool: step.tool
      });

      context.setTool(step.tool);

      executedTools.add(step.tool);

      try {
        const result =
          await this.toolRegistry.execute(
            step.tool,
            step.input,
            injectedContext
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

        completedSteps.add(stepNumber);

        const stepRecord = {
          step: stepNumber,
          tool: step.tool,
          input: step.input,
          dependsOn: step.dependsOn,
          result,
          success: true,
          completedAt: new Date().toISOString()
        };

        stepResults.push(stepRecord);

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
            stepsExecuted: stepNumber,
            stepResults
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
            stepsExecuted: stepNumber,
            stepResults
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
        context.steps.length,

      stepResults
    };
  }

  validateDependencies(steps) {
    const stepNumbers = new Set(
      steps.map((_, index) => index + 1)
    );

    for (
      let index = 0;
      index < steps.length;
      index += 1
    ) {
      const step = steps[index];
      const stepNumber = index + 1;

      if (step.dependsOn === null) {
        continue;
      }

      if (
        !Number.isInteger(step.dependsOn)
      ) {
        throw new AppError(
          `dependsOn في الخطوة ${stepNumber} غير صالح`,
          500,
          'INVALID_STEP_DEPENDENCY'
        );
      }

      if (
        step.dependsOn === stepNumber
      ) {
        throw new AppError(
          `الخطوة ${stepNumber} لا يمكن أن تعتمد على نفسها`,
          500,
          'SELF_STEP_DEPENDENCY'
        );
      }

      if (
        !stepNumbers.has(step.dependsOn)
      ) {
        throw new AppError(
          `الخطوة ${stepNumber} تعتمد على خطوة غير موجودة`,
          500,
          'DEPENDENCY_STEP_NOT_FOUND'
        );
      }

      if (
        step.dependsOn > stepNumber
      ) {
        throw new AppError(
          `الخطوة ${stepNumber} تعتمد على خطوة مستقبلية`,
          500,
          'FORWARD_STEP_DEPENDENCY'
        );
      }
    }
  }

  enforceDependency({
    step,
    stepNumber,
    completedSteps,
    context
  }) {
    if (step.dependsOn === null) {
      return;
    }

    if (
      !completedSteps.has(step.dependsOn)
    ) {
      context.record(
        'dependency.failed',
        {
          step: stepNumber,
          dependsOn: step.dependsOn,
          reason: 'dependency_not_completed'
        }
      );

      throw new AppError(
        `الخطوة ${stepNumber} لا يمكن تنفيذها قبل اكتمال الخطوة ${step.dependsOn}`,
        500,
        'DEPENDENCY_NOT_COMPLETED'
      );
    }

    context.record(
      'dependency.satisfied',
      {
        step: stepNumber,
        dependsOn: step.dependsOn
      }
    );
  }

  buildStepContext({
    plan,
    context,
    runtimeContext,
    step,
    stepNumber,
    previousResult,
    stepResults
  }) {
    return {
      ...runtimeContext,

      executionId:
        context.executionId,

      requestId:
        context.requestId,

      input:
        context.input,

      plan,

      step:
        stepNumber,

      tool:
        step.tool,

      stepInput:
        step.input,

      dependsOn:
        step.dependsOn,

      previousResult,

      previousSteps:
        stepResults.map((item) => ({
          step: item.step,
          tool: item.tool,
          result: item.result,
          success: item.success,
          completedAt: item.completedAt
        })),

      observations:
        context.observations,

      execution: {
        status: context.status,
        currentStep: context.currentStep,
        stepsExecuted: context.steps.length
      }
    };
  }

  normalizeSteps(plan) {
    if (Array.isArray(plan.steps)) {
      return plan.steps
        .filter(
          (step) =>
            step &&
            typeof step === 'object'
        )
        .map((step) => ({
          step:
            step.step === undefined
              ? null
              : step.step,

          tool:
            typeof step.tool === 'string'
              ? step.tool.trim()
              : null,

          input:
            step.input === undefined
              ? null
              : step.input,

          dependsOn:
            step.dependsOn === undefined
              ? null
              : step.dependsOn
        }));
    }

    if (plan.tool) {
      return [
        {
          step: 1,
          tool: plan.tool,
          input:
            plan.input === undefined
              ? null
              : plan.input,
          dependsOn: null
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
