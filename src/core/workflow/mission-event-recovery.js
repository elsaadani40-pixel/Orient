const AppError = require('../errors/AppError');
const MissionEventProjection = require('./mission-event-projection');
const WorkflowInstance = require('./workflow-instance');

function recoveryError(message, code = 'MISSION_RECOVERY_INVALID', status = 409) {
  return new AppError(message, status, code);
}

class MissionEventRecovery {
  constructor({ eventRepository, workflowRepository, clock = () => new Date() } = {}) {
    if (!eventRepository || typeof eventRepository.findByAggregateId !== 'function') {
      throw new TypeError('eventRepository with findByAggregateId is required');
    }
    if (!workflowRepository || typeof workflowRepository.findById !== 'function') {
      throw new TypeError('workflowRepository with findById is required');
    }
    this.eventRepository = eventRepository;
    this.workflowRepository = workflowRepository;
    this.clock = clock;
    this.projection = new MissionEventProjection({ clock });
  }

  _load(workflowId, tenantId) {
    const events = this.eventRepository.findByAggregateId(workflowId, { tenantId });
    if (!events.length) throw recoveryError('Mission event history is required for recovery', 'MISSION_EVENT_HISTORY_REQUIRED');
    let snapshot = this.workflowRepository.findById(workflowId, tenantId);
    if (!snapshot) snapshot = this.workflowRepository.findById(workflowId);
    return { events, snapshot };
  }

  _validateSnapshot(snapshot, workflowId, tenantId) {
    if (!snapshot) return null;
    if (snapshot.workflowId !== workflowId) throw recoveryError('Workflow snapshot aggregate mismatch', 'MISSION_SNAPSHOT_AGGREGATE_MISMATCH');
    if ((snapshot.tenantId || 'local') !== (tenantId || 'local')) throw recoveryError('Workflow snapshot tenant mismatch', 'MISSION_SNAPSHOT_TENANT_MISMATCH');
    try {
      return WorkflowInstance.fromJSON(snapshot);
    } catch (error) {
      const wrapped = recoveryError('Workflow snapshot is corrupt', 'MISSION_SNAPSHOT_CORRUPT');
      wrapped.cause = error;
      throw wrapped;
    }
  }

  _isEquivalent(snapshot, projected) {
    if (!snapshot) return false;
    return JSON.stringify({
      state: snapshot.state,
      steps: snapshot.steps,
      retry: snapshot.retry,
      cancelRequested: snapshot.cancelRequested,
      deadlineAt: snapshot.deadlineAt,
      recovery: snapshot.recovery,
      compensation: snapshot.compensation,
      input: snapshot.input
    }) === JSON.stringify({
      state: projected.state,
      steps: projected.steps,
      retry: projected.retry,
      cancelRequested: projected.cancelRequested,
      deadlineAt: projected.deadlineAt,
      recovery: projected.recovery,
      compensation: projected.compensation,
      input: projected.input
    });
  }

  reconcile(workflowId, tenantId = 'local') {
    const { events, snapshot: rawSnapshot } = this._load(workflowId, tenantId);
    const lastSequence = Number(events[events.length - 1].sequence);
    if (!Number.isInteger(lastSequence) || lastSequence < 1) {
      throw recoveryError('Mission event sequence is invalid', 'MISSION_EVENT_SEQUENCE_INVALID');
    }

    const snapshot = this._validateSnapshot(rawSnapshot, workflowId, tenantId);
    const snapshotRevision = Number(snapshot?.checkpoint?.revision || 0);
    if (!Number.isInteger(snapshotRevision) || snapshotRevision < 0) {
      throw recoveryError('Workflow checkpoint revision is invalid', 'MISSION_CHECKPOINT_MISMATCH');
    }
    if (snapshotRevision > lastSequence) {
      throw recoveryError('Workflow snapshot is ahead of durable event history', 'MISSION_SNAPSHOT_AHEAD_OF_EVENTS');
    }

    const projected = this.projection.rebuild(events);
    if (projected.workflowId !== workflowId || (projected.tenantId || 'local') !== (tenantId || 'local')) {
      throw recoveryError('Projected mission identity mismatch', 'MISSION_PROJECTION_IDENTITY_MISMATCH');
    }

    const healthy = Boolean(snapshot) && snapshotRevision === lastSequence && this._isEquivalent(snapshot, projected);
    if (healthy) return { status: 'HEALTHY', workflow: snapshot, lastSequence, snapshotRevision };

    const repaired = WorkflowInstance.fromJSON(projected.toJSON());
    repaired.setCheckpointRevision(snapshotRevision, snapshot?.checkpoint?.lastSavedAt || null);
    if (typeof this.workflowRepository.repair === 'function') {
      this.workflowRepository.repair(repaired, {
        tenantId,
        expectedRevision: snapshotRevision,
        targetRevision: lastSequence
      });
    } else {
      throw recoveryError('Workflow repository repair capability is required', 'MISSION_REPAIR_UNSUPPORTED', 500);
    }
    repaired.setCheckpointRevision(lastSequence, this.clock().toISOString());
    return { status: 'REPAIRED', workflow: repaired, lastSequence, snapshotRevision };
  }

  reconstruct(workflowId, tenantId = 'local') {
    return this.reconcile(workflowId, tenantId).workflow;
  }
}

module.exports = MissionEventRecovery;
