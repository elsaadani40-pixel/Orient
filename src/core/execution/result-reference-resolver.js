const AppError = require('../errors/AppError');

class ResultReferenceResolver {
  constructor() {
    this.name = 'ORIENT_RESULT_REFERENCE_RESOLVER';
    this.version = '0.7.4';
  }

  resolve(value, context = {}) {
    if (!context || typeof context !== 'object') {
      throw new AppError(
        'سياق حل النتائج غير صالح',
        500,
        'INVALID_RESULT_RESOLUTION_CONTEXT'
      );
    }

    return this.resolveValue(value, context);
  }

  resolveValue(value, context) {
    if (typeof value === 'string') {
      return this.resolveString(value, context);
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        this.resolveValue(item, context)
      );
    }

    if (
      value &&
      typeof value === 'object'
    ) {
      const resolved = {};

      for (const [key, item] of Object.entries(value)) {
        resolved[key] =
          this.resolveValue(item, context);
      }

      return resolved;
    }

    return value;
  }

  resolveString(value, context) {
    const trimmed = value.trim();

    if (trimmed === '$previousResult') {
      return context.previousResult;
    }

    const exactStepMatch =
      trimmed.match(
        /^\$step\.(\d+)\.result$/
      );

    if (exactStepMatch) {
      const stepNumber =
        Number(exactStepMatch[1]);

      return this.getStepResult(
        stepNumber,
        context
      );
    }

    return value;
  }

  getStepResult(stepNumber, context) {
    if (
      !Number.isInteger(stepNumber) ||
      stepNumber < 1
    ) {
      throw new AppError(
        'مرجع الخطوة غير صالح',
        500,
        'INVALID_STEP_RESULT_REFERENCE'
      );
    }

    const stepResults =
      Array.isArray(context.stepResults)
        ? context.stepResults
        : [];

    const match =
      stepResults.find(
        (item) =>
          item &&
          item.step === stepNumber
      );

    if (!match) {
      throw new AppError(
        `نتيجة الخطوة ${stepNumber} غير متاحة`,
        500,
        'STEP_RESULT_NOT_AVAILABLE'
      );
    }

    return match.result;
  }
}

module.exports = ResultReferenceResolver;
