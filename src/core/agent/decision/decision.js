const ACTIONS = Object.freeze({
  EXECUTE: 'execute',
  CONTINUE: 'continue',
  RETRY: 'retry',
  REPLAN: 'replan',
  RECOVER: 'recover',
  WAIT: 'wait',
  REQUEST_APPROVAL: 'request_approval',
  COMPLETE: 'complete',
  ABORT: 'abort'
});

class Decision {
  constructor({
    action,
    reason = '',
    confidence = 1,
    target = null,
    metadata = {}
  } = {}) {
    if (!Object.values(ACTIONS).includes(action)) {
      throw new Error('Invalid decision action');
    }

    this.action = action;
    this.reason = reason;
    this.confidence = confidence;
    this.target = target;
    this.metadata = { ...metadata };
  }

  toJSON() {
    return { ...this };
  }
}

Decision.ACTIONS = ACTIONS;

module.exports = Decision;
