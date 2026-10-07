const crypto = require('crypto');
const AppError = require('../errors/AppError');
const WorkflowDefinition = require('./workflow-definition');
const lifecyclePolicy = require('./workflow-lifecycle-policy');

const STATES = Object.freeze({
  CREATED: 'CREATED',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  RECOVERING: 'RECOVERING'
});

const STEP_STATES = WorkflowDefinition.STEP_STATES;

class WorkflowInstance {
  constructor({
    definition,
    workflowId = crypto.randomUUID(),
    tenantId = 'local',
    userId = 'local',
    workspaceId = 'local',
    input = {},
    now = () => new Date()
  }) {
    if (!(definition instanceof WorkflowDefinition)) {
      throw new AppError(
        'Workflow definition required',
        400,
        'WORKFLOW_DEFINITION_REQUIRED'
      );
    }

    this.workflowId = workflowId;
    this.tenantId = tenantId;
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.definition = definition;
    this.definitionId = definition.id;
    this.definitionVersion = definition.version;
    this.input = structuredClone(input);
    this.state = STATES.CREATED;
    this.createdAt = now().toISOString();
    this.updatedAt = this.createdAt;
    this.deadlineAt = null;
    this.cancelRequested = false;
    this.retry = {
      attempt: 0,
      nextAttemptAt: null,
      lastError: null
    };
    this.steps = Object.fromEntries(
      definition.steps.map((step) => [
        step.id,
        {
          state: STEP_STATES.PENDING,
          attempts: 0,
          result: null,
          error: null,
          startedAt: null,
          completedAt: null
        }
      ])
    );
    this.metadata = {};
  }

  static fromJSON(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new AppError(
        'Workflow payload required',
        400,
        'WORKFLOW_PAYLOAD_REQUIRED'
      );
    }

    const definitionPayload = payload.definition;
    if (!definitionPayload) {
      throw new AppError(
        'Persisted workflow definition is required for recovery',
        409,
        'WORKFLOW_DEFINITION_SNAPSHOT_REQUIRED'
      );
    }

    lifecyclePolicy.assertKnownState(payload.state || STATES.CREATED);

    const definition = new WorkflowDefinition(definitionPayload);
    const instance = new WorkflowInstance({
      definition,
      workflowId: payload.workflowId,
      tenantId: payload.tenantId || 'local',
      userId: payload.userId || 'local',
      workspaceId: payload.workspaceId || 'local',
      input: payload.input || {}
    });

    instance.state = payload.state || STATES.CREATED;
    instance.createdAt = payload.createdAt || instance.createdAt;
    instance.updatedAt = payload.updatedAt || instance.createdAt;
    instance.deadlineAt = payload.deadlineAt || null;
    instance.cancelRequested = Boolean(payload.cancelRequested);
    instance.retry = {
      attempt: Number(payload.retry?.attempt || 0),
      nextAttemptAt: payload.retry?.nextAttemptAt || null,
      lastError: payload.retry?.lastError || null
    };
    instance.metadata = structuredClone(payload.metadata || {});

    for (const step of definition.steps) {
      const persisted = payload.steps?.[step.id];
      if (!persisted) continue;
      instance.steps[step.id] = {
        state: persisted.state || STEP_STATES.PENDING,
        attempts: Number(persisted.attempts || 0),
        result: persisted.result ?? null,
        error: persisted.error ?? null,
        startedAt: persisted.startedAt || null,
        completedAt: persisted.completedAt || null
      };
    }

    return instance;
  }

  transition(next, now = () => new Date()) {
    lifecyclePolicy.assertTransition(this.state, next);
    this.state = next;
    this.updatedAt = now().toISOString();
    return this;
  }

  readySteps() {
    return this.definition.steps.filter(
      (step) =>
        this.steps[step.id].state === STEP_STATES.PENDING &&
        step.dependsOn.every(
          (dependency) =>
            this.steps[dependency].state === STEP_STATES.COMPLETED
        )
    );
  }

  markStepRunning(id, now = () => new Date()) {
    if (!this.steps[id]) {
      throw new AppError(
        'Unknown workflow step: ' + id,
        404,
        'WORKFLOW_STEP_NOT_FOUND'
      );
    }

    this.steps[id].state = STEP_STATES.RUNNING;
    this.steps[id].attempts += 1;
    this.steps[id].startedAt = now().toISOString();
    this.steps[id].error = null;
  }

  markStepCompleted(id, result, now = () => new Date()) {
    if (!this.steps[id]) {
      throw new AppError(
        'Unknown workflow step: ' + id,
        404,
        'WORKFLOW_STEP_NOT_FOUND'
      );
    }

    this.steps[id].state = STEP_STATES.COMPLETED;
    this.steps[id].result = result;
    this.steps[id].error = null;
    this.steps[id].completedAt = now().toISOString();
  }

  markStepFailed(id, error, now = () => new Date()) {
    if (!this.steps[id]) {
      throw new AppError(
        'Unknown workflow step: ' + id,
        404,
        'WORKFLOW_STEP_NOT_FOUND'
      );
    }

    this.steps[id].state = STEP_STATES.FAILED;
    this.steps[id].error = {
      message: error?.message || String(error),
      code: error?.code || 'WORKFLOW_STEP_FAILED'
    };
    this.steps[id].completedAt = now().toISOString();
  }

  resetStepForRetry(id) {
    if (!this.steps[id]) return;
    this.steps[id].state = STEP_STATES.PENDING;
    this.steps[id].error = null;
    this.steps[id].startedAt = null;
    this.steps[id].completedAt = null;
  }

  cancelStep(id) {
    if (!this.steps[id]) return;
    if (this.steps[id].state !== STEP_STATES.COMPLETED) {
      this.steps[id].state = STEP_STATES.CANCELLED;
    }
  }

  requestCancel() {
    this.cancelRequested = true;
    return this;
  }

  setDeadline(deadlineAt) {
    this.deadlineAt = deadlineAt;
    return this;
  }

  toJSON() {
    return {
      workflowId: this.workflowId,
      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      definitionId: this.definitionId,
      definitionVersion: this.definitionVersion,
      definition: this.definition.toJSON(),
      input: this.input,
      state: this.state,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deadlineAt: this.deadlineAt,
      cancelRequested: this.cancelRequested,
      retry: this.retry,
      steps: this.steps,
      metadata: this.metadata
    };
  }
}

WorkflowInstance.STATES = STATES;
WorkflowInstance.LIFECYCLE_TRANSITIONS = lifecyclePolicy.TRANSITIONS;
module.exports = WorkflowInstance;
