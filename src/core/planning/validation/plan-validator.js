const AppError = require('../../errors/AppError');

class PlanValidator {
  constructor({ maxSteps = 5, toolRegistry = null } = {}) {
    this.name = 'ORIENT_PLAN_VALIDATOR';
    this.version = '0.7.0';
    this.maxSteps = maxSteps;
    this.toolRegistry = toolRegistry;
  }

  validate(plan) {
    if (!plan || typeof plan !== 'object') {
      throw new AppError(
        'خطة التنفيذ غير صالحة',
        500,
        'INVALID_PLAN'
      );
    }

    if (
      typeof plan.intent !== 'string' ||
      !plan.intent.trim()
    ) {
      throw new AppError(
        'الخطة لا تحتوي على intent صالح',
        500,
        'PLAN_INTENT_REQUIRED'
      );
    }

    if (
      plan.confidence !== undefined &&
      (
        typeof plan.confidence !== 'number' ||
        plan.confidence < 0 ||
        plan.confidence > 1
      )
    ) {
      throw new AppError(
        'قيمة الثقة في الخطة غير صالحة',
        500,
        'PLAN_CONFIDENCE_INVALID'
      );
    }

    const steps = this.normalizeSteps(plan);

    if (steps.length > this.maxSteps) {
      throw new AppError(
        'الخطة تتجاوز الحد الأقصى للخطوات',
        500,
        'PLAN_MAX_STEPS_EXCEEDED'
      );
    }

    const seenStepIds = new Set();

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];

      if (!step.tool) {
        throw new AppError(
          `الخطوة ${index + 1} لا تحتوي على أداة`,
          500,
          'PLAN_STEP_TOOL_REQUIRED'
        );
      }

      if (
        this.toolRegistry &&
        !this.toolRegistry.has(step.tool)
      ) {
        throw new AppError(
          `الأداة "${step.tool}" غير مسجلة`,
          500,
          'PLAN_TOOL_NOT_REGISTERED'
        );
      }

      const stepId =
        step.step === undefined || step.step === null
          ? index + 1
          : step.step;

      if (seenStepIds.has(stepId)) {
        throw new AppError(
          `هوية الخطوة "${stepId}" مكررة داخل الخطة`,
          500,
          'PLAN_DUPLICATE_STEP_ID'
        );
      }

      if (step.dependsOn !== null &&
          (!Number.isInteger(step.dependsOn) || step.dependsOn < 1 || step.dependsOn > index)) {
        throw new AppError(
          `الخطوة ${index + 1} تعتمد على خطوة غير سابقة`,
          500,
          'PLAN_DEPENDENCY_INVALID'
        );
      }

      seenStepIds.add(stepId);
    }

    return {
      valid: true,
      steps
    };
  }

  normalizeSteps(plan) {
    if (Array.isArray(plan.steps)) {
      if (plan.steps.some(step => !step || typeof step !== 'object' || Array.isArray(step))) {
        throw new AppError('إحدى خطوات الخطة ليست كائنًا صالحًا', 500, 'PLAN_STEP_INVALID');
      }
      return plan.steps.map((step, index) => ({
        step: index + 1,
        tool: typeof step.tool === 'string' ? step.tool.trim() : null,
        input: step.input === undefined ? null : step.input,
        dependsOn: step.dependsOn === undefined ? null : step.dependsOn,
        ...(typeof step.agentId === 'string' ? { agentId: step.agentId } : {}),
        ...(typeof step.capability === 'string' ? { capability: step.capability } : {}),
        ...(typeof step.memoryScope === 'string' ? { memoryScope: step.memoryScope } : {})
      }));
    }

    if (plan.tool) {
      return [{
        step: 1,
        tool: plan.tool,
        input: plan.input === undefined ? null : plan.input,
        dependsOn: null
      }];
    }

    return [];
  }
}

module.exports = PlanValidator;
