const crypto = require('crypto');

const AppError = require('../../errors/AppError');

const {
  GOAL_STATUS,
  isValidGoalStatus
} = require('./goal.status');

const DEFAULT_PRIORITY = 5;

class Goal {
  constructor({
    id,
    objective,
    status = GOAL_STATUS.CREATED,
    priority = DEFAULT_PRIORITY,
    constraints = {},
    desiredState = {},
    metadata = {},
    createdAt,
    updatedAt
  } = {}) {
    const normalizedObjective =
      typeof objective === 'string'
        ? objective.trim()
        : '';

    if (!normalizedObjective) {
      throw new AppError(
        'هدف الـ Agent مطلوب',
        400,
        'GOAL_OBJECTIVE_REQUIRED'
      );
    }

    if (!isValidGoalStatus(status)) {
      throw new AppError(
        'حالة الهدف غير صالحة',
        500,
        'INVALID_GOAL_STATUS'
      );
    }

    if (
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 10
    ) {
      throw new AppError(
        'أولوية الهدف غير صالحة',
        500,
        'INVALID_GOAL_PRIORITY'
      );
    }

    this.id =
      typeof id === 'string' && id.trim()
        ? id.trim()
        : crypto.randomUUID();

    this.objective = normalizedObjective;
    this.status = status;
    this.priority = priority;

    this.constraints =
      constraints &&
      typeof constraints === 'object' &&
      !Array.isArray(constraints)
        ? { ...constraints }
        : {};

    this.desiredState =
      desiredState &&
      typeof desiredState === 'object' &&
      !Array.isArray(desiredState)
        ? { ...desiredState }
        : {};

    this.metadata =
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata)
        ? { ...metadata }
        : {};

    const now = new Date().toISOString();

    this.createdAt =
      typeof createdAt === 'string' && createdAt
        ? createdAt
        : now;

    this.updatedAt =
      typeof updatedAt === 'string' && updatedAt
        ? updatedAt
        : now;
  }

  activate() {
    this.transitionTo(GOAL_STATUS.ACTIVE);
    return this;
  }

  pause() {
    this.transitionTo(GOAL_STATUS.PAUSED);
    return this;
  }

  complete() {
    this.transitionTo(GOAL_STATUS.COMPLETED);
    return this;
  }

  fail() {
    this.transitionTo(GOAL_STATUS.FAILED);
    return this;
  }

  cancel() {
    this.transitionTo(GOAL_STATUS.CANCELLED);
    return this;
  }

  block() {
    this.transitionTo(GOAL_STATUS.BLOCKED);
    return this;
  }

  transitionTo(status) {
    if (!isValidGoalStatus(status)) {
      throw new AppError(
        'حالة الهدف الجديدة غير صالحة',
        500,
        'INVALID_GOAL_TRANSITION_STATUS'
      );
    }

    this.status = status;
    this.updatedAt = new Date().toISOString();

    return this;
  }

  toJSON() {
    return {
      id: this.id,
      objective: this.objective,
      status: this.status,
      priority: this.priority,
      constraints: { ...this.constraints },
      desiredState: { ...this.desiredState },
      metadata: { ...this.metadata },
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

Goal.STATUS = GOAL_STATUS;

module.exports = Goal;
