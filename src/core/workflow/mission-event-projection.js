const AppError = require('../errors/AppError');
const WorkflowDefinition = require('./workflow-definition');
const WorkflowInstance = require('./workflow-instance');

const EVENT_TYPES = Object.freeze({
  CREATED: 'workflow.created',
  STATE_CHANGED: 'workflow.state.changed',
  STEP_RUNNING: 'workflow.step.running',
  STEP_COMPLETED: 'workflow.step.completed',
  STEP_FAILED: 'workflow.step.failed',
  STEP_RETRY: 'workflow.step.retry',
  RECOVERED: 'workflow.recovered',
  CHECKPOINTED: 'workflow.checkpoint.saved',
  COMPENSATION_STARTED: 'workflow.compensation.started',
  COMPENSATION_ACTION: 'workflow.compensation.action',
  COMPENSATION_COMPLETED: 'workflow.compensation.completed',
  COMPENSATION_FAILED: 'workflow.compensation.failed'
});

function projectionError(message, code = 'MISSION_PROJECTION_INVALID') {
  return new AppError(message, 409, code);
}

class MissionEventProjection {
  constructor({ clock = () => new Date() } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.clock = clock;
  }

  _sortedUnique(events) {
    if (!Array.isArray(events)) throw projectionError('Mission events must be an array', 'MISSION_EVENTS_REQUIRED');
    const byId = new Map();
    for (const event of events) {
      if (!event || typeof event !== 'object' || !event.id) {
        throw projectionError('Mission event id is required', 'MISSION_EVENT_ID_REQUIRED');
      }
      if (byId.has(event.id)) continue;
      byId.set(event.id, event);
    }
    return [...byId.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }

  _assertSequence(event, expected) {
    if (!Number.isInteger(Number(event.sequence)) || Number(event.sequence) !== expected) {
      throw projectionError(
        'Mission event sequence gap or reordering at sequence ' + String(event.sequence),
        'MISSION_EVENT_SEQUENCE_GAP'
      );
    }
  }

  _transition(instance, next) {
    if (instance.state === next) return;
    instance.transition(next, this.clock);
  }

  rebuild(events) {
    const ordered = this._sortedUnique(events);
    if (!ordered.length) throw projectionError('Mission event stream is empty', 'MISSION_EVENT_STREAM_EMPTY');

    const aggregateId = ordered[0].aggregateId;
    if (!aggregateId) throw projectionError('Mission aggregate id is required', 'MISSION_AGGREGATE_ID_REQUIRED');

    let instance = null;
    let lastSequence = 0;

    for (const event of ordered) {
      if (event.aggregateId !== aggregateId) {
        throw projectionError('Mission event aggregate mismatch', 'MISSION_EVENT_AGGREGATE_MISMATCH');
      }

      this._assertSequence(event, lastSequence + 1);

      if (!instance) {
        if (event.type !== EVENT_TYPES.CREATED || event.data?.definition == null) {
          throw projectionError('Mission stream must begin with workflow.created', 'MISSION_EVENT_ROOT_REQUIRED');
        }
        const definition = new WorkflowDefinition(event.data.definition);
        instance = new WorkflowInstance({
          definition,
          workflowId: event.data.workflowId || aggregateId,
          tenantId: event.data.tenantId || 'local',
          userId: event.data.userId || 'local',
          workspaceId: event.data.workspaceId || 'local',
          input: event.data.input || {},
          now: this.clock
        });
        if (event.data.createdAt) instance.createdAt = event.data.createdAt;
        instance.updatedAt = event.timestamp || instance.updatedAt;
      } else {
        this.apply(instance, event);
      }

      lastSequence = Number(event.sequence);
    }

    instance.metadata = { ...instance.metadata, projection: { lastSequence, aggregateId } };
    return instance;
  }

  apply(instance, event) {
    const data = event.data || {};
    switch (event.type) {
      case EVENT_TYPES.STATE_CHANGED:
        if (!data.to) throw projectionError('State change target is required', 'MISSION_STATE_TARGET_REQUIRED');
        this._transition(instance, data.to);
        break;
      case EVENT_TYPES.STEP_RUNNING:
        instance.markStepRunning(data.stepId, this.clock);
        break;
      case EVENT_TYPES.STEP_COMPLETED:
        instance.markStepCompleted(data.stepId, data.result, this.clock);
        break;
      case EVENT_TYPES.STEP_FAILED:
        instance.markStepFailed(data.stepId, data.error || new Error('Workflow step failed'), this.clock);
        break;
      case EVENT_TYPES.STEP_RETRY:
        instance.resetStepForRetry(data.stepId);
        break;
      case EVENT_TYPES.RECOVERED:
        instance.recoverFromLeaseLoss(data.reason || 'EVENT_REPLAY', this.clock);
        break;
      case EVENT_TYPES.CHECKPOINTED: {
        const revision = Number(data.revision);
        if (!Number.isInteger(revision) || revision < instance.checkpoint.revision) {
          throw projectionError('Checkpoint revision is invalid or regressed', 'MISSION_CHECKPOINT_MISMATCH');
        }
        instance.setCheckpointRevision(revision, event.timestamp || this.clock().toISOString());
        break;
      }
      case EVENT_TYPES.COMPENSATION_STARTED:
        instance.beginCompensation(this.clock);
        break;
      case EVENT_TYPES.COMPENSATION_ACTION:
        instance.recordCompensationAction(data.action, this.clock);
        break;
      case EVENT_TYPES.COMPENSATION_COMPLETED:
        instance.markCompensationCompleted(data.actionId, this.clock);
        break;
      case EVENT_TYPES.COMPENSATION_FAILED:
        instance.markCompensationFailed(data.actionId, data.error || new Error('Compensation failed'), this.clock);
        break;
      default:
        throw projectionError('Unsupported mission event type ' + String(event.type), 'MISSION_EVENT_UNSUPPORTED');
    }
    instance.updatedAt = event.timestamp || instance.updatedAt;
    return instance;
  }
}

MissionEventProjection.EVENT_TYPES = EVENT_TYPES;
module.exports = MissionEventProjection;
