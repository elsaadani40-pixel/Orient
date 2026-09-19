const AppError = require('../../errors/AppError');

const ReplanningDecision =
  require('./replanning-decision');

class Replanner {
  constructor({ maxReplans = 3 } = {}) {
    if (
      !Number.isInteger(maxReplans) ||
      maxReplans < 0
    ) {
      throw new AppError(
        'الحد الأقصى لإعادة التخطيط غير صالح',
        500,
        'INVALID_MAX_REPLANS'
      );
    }

    this.name = 'ORIENT_REPLANNER';
    this.version = '0.8.0';
    this.maxReplans = maxReplans;
  }

  decide({
    evaluation,
    replans = 0,
    hasRemainingSteps = false
  }) {
    if (
      !evaluation ||
      typeof evaluation !== 'object'
    ) {
      throw new AppError(
        'Evaluation مطلوبة لإعادة التخطيط',
        500,
        'REPLANNING_EVALUATION_REQUIRED'
      );
    }

    if (
      !Number.isInteger(replans) ||
      replans < 0
    ) {
      throw new AppError(
        'عدد عمليات إعادة التخطيط غير صالح',
        500,
        'INVALID_REPLAN_COUNT'
      );
    }

    if (evaluation.outcome === 'failed') {
      return ReplanningDecision.failed(
        evaluation.reason ||
        'فشل تنفيذ المهمة'
      );
    }

    if (evaluation.outcome === 'done') {
      return ReplanningDecision.done(
        evaluation.reason ||
        'اكتملت المهمة'
      );
    }

    if (evaluation.outcome === 'replan') {
      if (replans >= this.maxReplans) {
        return ReplanningDecision.failed(
          'تم الوصول إلى الحد الأقصى لإعادة التخطيط'
        );
      }

      return ReplanningDecision.replan(
        evaluation.reason ||
        'تحتاج المهمة إلى إعادة تخطيط'
      );
    }

    if (
      evaluation.outcome === 'next_step' ||
      evaluation.outcome === 'continue'
    ) {
      if (hasRemainingSteps) {
        return ReplanningDecision.nextStep(
          evaluation.reason ||
          'الانتقال إلى الخطوة التالية'
        );
      }

      if (replans >= this.maxReplans) {
        return ReplanningDecision.failed(
          'لا توجد خطوات متبقية وتم الوصول إلى حد إعادة التخطيط'
        );
      }

      return ReplanningDecision.replan(
        'لا توجد خطوات متبقية؛ يلزم إنشاء خطة جديدة'
      );
    }

    return ReplanningDecision.replan(
      'نتيجة التقييم غير معروفة؛ يلزم إعادة التخطيط'
    );
  }
}

module.exports = Replanner;
