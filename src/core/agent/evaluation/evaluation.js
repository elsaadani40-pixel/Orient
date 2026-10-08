class Evaluation {
  constructor({
    outcome,
    goalProgress = 0,
    confidence = 1,
    reason = '',
    blockers = [],
    recommendations = [],
    nextAction = null,
    nextInput = null
  } = {}) {
    if (!outcome) {
      throw new Error('outcome is required');
    }

    this.outcome = outcome;
    this.goalProgress = goalProgress;
    this.confidence = confidence;
    this.reason = reason;
    this.blockers = [...blockers];
    this.recommendations = [...recommendations];
    this.nextAction = nextAction;
    this.nextInput = nextInput;
  }

  toJSON() {
    return { ...this };
  }
}

module.exports = Evaluation;
