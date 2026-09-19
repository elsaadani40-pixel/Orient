const Evaluation = require('./evaluation');

class EvaluationEngine {
  evaluate({
    observations = [],
    goalProgress = 0
  } = {}) {
    if (!Array.isArray(observations)) {
      throw new TypeError('Observations must be an array');
    }

    const failed =
      observations.some(
        (observation) =>
          observation &&
          observation.outcome === 'failed'
      );

    if (failed) {
      return new Evaluation({
        outcome: 'failed',
        goalProgress,
        confidence: 1,
        reason: 'حدث فشل أثناء التنفيذ'
      });
    }

    if (goalProgress >= 1) {
      return new Evaluation({
        outcome: 'done',
        goalProgress: 1,
        confidence: 1,
        reason: 'تم تحقيق الهدف'
      });
    }

    return new Evaluation({
      outcome: 'continue',
      goalProgress,
      confidence: 1,
      reason: 'الهدف لم يكتمل بعد'
    });
  }
}

module.exports = EvaluationEngine;
