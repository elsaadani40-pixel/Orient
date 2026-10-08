const Evaluation = require('./evaluation');

class EvaluationEngine {
  evaluate({
    plan = null,
    step = null,
    result,
    stepNumber = 1,
    observations = [],
    goalProgress = null
  } = {}) {
    if (!Array.isArray(observations)) {
      throw new TypeError('Observations must be an array');
    }

    if (Array.isArray(plan?.steps) && plan.steps.length === 0) {
      return new Evaluation({
        outcome: 'no_action',
        goalProgress: 0,
        confidence: 1,
        reason: 'لا توجد خطوات قابلة للتنفيذ',
        nextAction: null
      });
    }

    if (result === undefined) {
      return new Evaluation({
        outcome: 'failed',
        goalProgress: 0,
        confidence: 1,
        reason: `الخطوة ${stepNumber} لم تُرجع نتيجة`,
        blockers: ['missing_result']
      });
    }

    const failedObservation = observations.find(
      (observation) =>
        observation &&
        (observation.outcome === 'failed' ||
          observation.success === false)
    );

    if (failedObservation) {
      return new Evaluation({
        outcome: 'failed',
        goalProgress: Number.isFinite(goalProgress) ? goalProgress : 0,
        confidence: 1,
        reason: 'حدث فشل أثناء التنفيذ',
        blockers: ['execution_failure']
      });
    }

    if (
      result &&
      typeof result === 'object' &&
      (result.nextAction === 'replan' || result.outcome === 'replan')
    ) {
      return new Evaluation({
        outcome: 'replan',
        goalProgress: Number.isFinite(goalProgress) ? goalProgress : 0,
        confidence: 1,
        reason:
          result.reason ||
          `الخطوة ${stepNumber} طلبت إعادة التخطيط`,
        recommendations: [
          result.nextInput ? 'replan_with_next_input' : 'replan'
        ],
        nextAction: 'replan',
        nextInput:
          typeof result.nextInput === 'string'
            ? result.nextInput.trim()
            : null
      });
    }

    const hasNextStep =
      Array.isArray(plan?.steps) &&
      stepNumber < plan.steps.length;

    const resolvedProgress = Number.isFinite(goalProgress)
      ? goalProgress
      : hasNextStep
        ? Math.max(0, Math.min(1, stepNumber / plan.steps.length))
        : 1;

    return new Evaluation({
      outcome: hasNextStep ? 'continue' : 'done',
      goalProgress: resolvedProgress,
      confidence: 1,
      reason: hasNextStep
        ? `تم تنفيذ ${step?.tool || 'الخطوة'} بنجاح، الانتقال للخطوة التالية`
        : `تم تنفيذ ${step?.tool || 'الخطوة'} بنجاح`,
      recommendations: hasNextStep ? ['next_step'] : [],
      nextAction: hasNextStep ? 'next_step' : null
    });
  }
}

module.exports = EvaluationEngine;
