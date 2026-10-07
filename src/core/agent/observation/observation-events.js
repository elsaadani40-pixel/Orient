const OBSERVATION_EVENTS = Object.freeze({
  GOAL_CREATED: 'goal.created',
  GOAL_UPDATED: 'goal.updated',

  PLAN_CREATED: 'plan.created',
  PLAN_VALIDATED: 'plan.validated',
  PLAN_REJECTED: 'plan.rejected',

  EXECUTION_STARTED: 'execution.started',
  STEP_STARTED: 'execution.step.started',
  STEP_COMPLETED: 'execution.step.completed',
  STEP_FAILED: 'execution.step.failed',

  OBSERVATION_CREATED: 'observation.created',
  EVALUATION_COMPLETED: 'evaluation.completed',
  DECISION_CREATED: 'decision.created',

  MEMORY_CREATED: 'memory.created',
  MEMORY_REINFORCED: 'memory.reinforced',
  MEMORY_CONFLICT_RESOLVED: 'memory.conflict.resolved',
  MEMORY_ACCESSED: 'memory.accessed',
  MEMORY_CONSOLIDATED: 'memory.consolidated',
  MEMORY_ARCHIVED: 'memory.archived',

  RECOVERY_STARTED: 'recovery.started',
  RECOVERY_COMPLETED: 'recovery.completed',

  EXECUTION_COMPLETED: 'execution.completed',
  EXECUTION_FAILED: 'execution.failed'
});

module.exports = OBSERVATION_EVENTS;
