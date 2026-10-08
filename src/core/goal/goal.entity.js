'use strict';

const crypto = require('crypto');

const GOAL_STATUS = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const TRANSITIONS = Object.freeze({
  created: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([])
});

class Goal {
  constructor({
    id = null,
    input,
    executionId = null,
    tenantId = null,
    userId = null,
    workspaceId = null,
    metadata = {}
  } = {}) {
    if (input === undefined || input === null || !String(input).trim()) {
      throw new TypeError('goal input is required');
    }

    this.id = id || crypto.randomUUID();
    this.input = String(input);
    this.executionId = executionId || null;
    this.tenantId = tenantId || null;
    this.userId = userId || null;
    this.workspaceId = workspaceId || null;
    this.metadata = { ...metadata };
    this.status = GOAL_STATUS.CREATED;
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.completedAt = null;
  }

  transitionTo(nextStatus) {
    if (!Object.values(GOAL_STATUS).includes(nextStatus)) {
      throw new TypeError('invalid goal status');
    }
    if (!TRANSITIONS[this.status].has(nextStatus)) {
      throw new Error(`Cannot transition goal from "${this.status}" to "${nextStatus}"`);
    }

    this.status = nextStatus;
    if (nextStatus === GOAL_STATUS.RUNNING) this.startedAt = new Date().toISOString();
    if ([GOAL_STATUS.COMPLETED, GOAL_STATUS.FAILED, GOAL_STATUS.CANCELLED].includes(nextStatus)) {
      this.completedAt = new Date().toISOString();
    }
    return this;
  }

  snapshot() {
    return {
      id: this.id,
      input: this.input,
      executionId: this.executionId,
      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      metadata: { ...this.metadata },
      status: this.status,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt
    };
  }
}

Goal.STATUS = GOAL_STATUS;

module.exports = Goal;
