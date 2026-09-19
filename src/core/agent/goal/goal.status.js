const GOAL_STATUS = Object.freeze({
  CREATED: 'created',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked'
});

function isValidGoalStatus(status) {
  return Object.values(GOAL_STATUS).includes(status);
}

module.exports = {
  GOAL_STATUS,
  isValidGoalStatus
};
