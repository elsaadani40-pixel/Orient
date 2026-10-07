const TRANSITIONS = Object.freeze({
  CREATED: Object.freeze(['QUEUED', 'CANCELLED']),
  QUEUED: Object.freeze(['RUNNING', 'CANCELLED', 'WAITING', 'FAILED']),
  RUNNING: Object.freeze(['WAITING', 'COMPLETED', 'FAILED', 'CANCELLED', 'RECOVERING']),
  WAITING: Object.freeze(['QUEUED', 'RUNNING', 'CANCELLED', 'FAILED']),
  RECOVERING: Object.freeze(['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED']),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([])
});

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

function assertKnownState(state) {
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, state)) {
    throw new AppError('Invalid workflow state ' + state, 409, 'WORKFLOW_INVALID_STATE');
  }
}

function assertTransition(from, to) {
  assertKnownState(from);
  assertKnownState(to);
  if (!canTransition(from, to)) {
    throw new AppError(
      'Invalid workflow transition ' + from + ' -> ' + to,
      409,
      'WORKFLOW_INVALID_TRANSITION'
    );
  }
}

const AppError = require('../errors/AppError');

module.exports = Object.freeze({ TRANSITIONS, canTransition, assertKnownState, assertTransition });
