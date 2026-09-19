const AppError = require('../../errors/AppError');

const OUTCOMES = Object.freeze({
  DONE: 'done',
  NEXT_STEP: 'next_step',
  REPLAN: 'replan',
  FAILED: 'failed'
});

const ACTIONS = Object.freeze({
  NONE: null,
  CONTINUE: 'continue',
  REPLAN: 'replan',
  STOP: 'stop'
});

class ReplanningDecision {
  constructor({
    outcome,
    nextAction = ACTIONS.NONE,
    reason = '',
    confidence = 1,
    metadata = {}
  }) {
    if (!Object.values(OUTCOMES).includes(outcome)) {
      throw new AppError(
        'نتيجة إعادة التخطيط غير صالحة',
        500,
        'INVALID_REPLANNING_OUTCOME'
      );
    }

    if (
      nextAction !== null &&
      !Object.values(ACTIONS).includes(nextAction)
    ) {
      throw new AppError(
        'الإجراء التالي غير صالح',
        500,
        'INVALID_REPLANNING_ACTION'
      );
    }

    if (
      typeof confidence !== 'number' ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new AppError(
        'درجة الثقة غير صالحة',
        500,
        'INVALID_REPLANNING_CONFIDENCE'
      );
    }

    this.outcome = outcome;
    this.nextAction = nextAction;
    this.reason = String(reason || '');
    this.confidence = confidence;
    this.metadata =
      metadata &&
      typeof metadata === 'object'
        ? { ...metadata }
        : {};
  }

  toJSON() {
    return {
      outcome: this.outcome,
      nextAction: this.nextAction,
      reason: this.reason,
      confidence: this.confidence,
      metadata: this.metadata
    };
  }

  static done(reason = 'اكتملت المهمة') {
    return new ReplanningDecision({
      outcome: OUTCOMES.DONE,
      nextAction: ACTIONS.NONE,
      reason
    });
  }

  static nextStep(reason = 'الانتقال إلى الخطوة التالية') {
    return new ReplanningDecision({
      outcome: OUTCOMES.NEXT_STEP,
      nextAction: ACTIONS.CONTINUE,
      reason
    });
  }

  static replan(reason = 'تحتاج المهمة إلى إعادة تخطيط') {
    return new ReplanningDecision({
      outcome: OUTCOMES.REPLAN,
      nextAction: ACTIONS.REPLAN,
      reason
    });
  }

  static failed(reason = 'فشل تنفيذ المهمة') {
    return new ReplanningDecision({
      outcome: OUTCOMES.FAILED,
      nextAction: ACTIONS.STOP,
      reason
    });
  }
}

ReplanningDecision.OUTCOMES = OUTCOMES;
ReplanningDecision.ACTIONS = ACTIONS;

module.exports = ReplanningDecision;
