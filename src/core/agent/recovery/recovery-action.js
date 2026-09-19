const ACTIONS = Object.freeze({
  RETRY: 'retry',
  ALTERNATIVE: 'alternative',
  REPLAN: 'replan',
  APPROVAL: 'approval',
  ABORT: 'abort'
});

class RecoveryAction {
  constructor({
    action,
    reason = '',
    target = null,
    metadata = {}
  } = {}) {
    if (!Object.values(ACTIONS).includes(action)) {
      throw new Error('Invalid recovery action');
    }

    this.action = action;
    this.reason = reason;
    this.target = target;
    this.metadata = { ...metadata };
  }

  toJSON() {
    return { ...this };
  }
}

RecoveryAction.ACTIONS = ACTIONS;

module.exports = RecoveryAction;
