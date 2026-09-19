const Decision = require('./decision');

class DecisionEngine {
  decide(evaluation) {
    if (!evaluation) {
      throw new Error('Evaluation is required');
    }

    switch (evaluation.outcome) {
      case 'done':
        return new Decision({
          action: Decision.ACTIONS.COMPLETE,
          reason: evaluation.reason
        });

      case 'failed':
        return new Decision({
          action: Decision.ACTIONS.ABORT,
          reason: evaluation.reason
        });

      case 'replan':
        return new Decision({
          action: Decision.ACTIONS.REPLAN,
          reason: evaluation.reason
        });

      case 'recover':
        return new Decision({
          action: Decision.ACTIONS.RECOVER,
          reason: evaluation.reason
        });

      case 'wait':
        return new Decision({
          action: Decision.ACTIONS.WAIT,
          reason: evaluation.reason
        });

      default:
        return new Decision({
          action: Decision.ACTIONS.CONTINUE,
          reason: evaluation.reason || 'استمرار التنفيذ'
        });
    }
  }
}

module.exports = DecisionEngine;
