const LIFECYCLE_TRANSITIONS = Object.freeze({
  created: Object.freeze(['understanding', 'cancelled']),
  understanding: Object.freeze(['planning', 'completed', 'recovering', 'cancelled', 'failed']),
  planning: Object.freeze(['validating', 'recovering', 'cancelled', 'failed']),
  validating: Object.freeze(['executing', 'recovering', 'cancelled', 'failed']),
  executing: Object.freeze(['observing', 'recovering', 'waiting', 'completed', 'cancelled', 'failed']),
  observing: Object.freeze(['evaluating', 'recovering', 'waiting', 'cancelled', 'failed']),
  evaluating: Object.freeze(['planning', 'executing', 'waiting', 'completed', 'recovering', 'cancelled', 'failed']),
  recovering: Object.freeze(['understanding', 'planning', 'validating', 'executing', 'waiting', 'failed', 'cancelled']),
  waiting: Object.freeze(['executing', 'completed', 'cancelled', 'failed']),
  completed: Object.freeze([]),
  failed: Object.freeze(['recovering']),
  cancelled: Object.freeze([])
});

function canTransition(from, to) {
  return Boolean(LIFECYCLE_TRANSITIONS[from]?.includes(to));
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new Error('Invalid agent lifecycle transition ' + from + ' -> ' + to);
    error.code = 'AGENT_INVALID_LIFECYCLE_TRANSITION';
    error.statusCode = 409;
    throw error;
  }
}

module.exports = Object.freeze({
  LIFECYCLE_TRANSITIONS,
  canTransition,
  assertTransition
});
