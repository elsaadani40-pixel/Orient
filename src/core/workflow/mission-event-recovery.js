const AppError = require('../errors/AppError');
const { isDeepStrictEqual } = require('node:util');
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

  async _load(workflowId, tenantId) {
    const events = await this.eventRepository.findByAggregateId(workflowId, { tenantId });
    const snapshot = await this.workflowRepository.findById(workflowId, tenantId);
    const validatedSnapshot = this._validateSnapshot(snapshot, workflowId, tenantId);

    if (!events.length) {
      const revision = Number(validatedSnapshot?.checkpoint?.revision || 0);
      if (!Number.isInteger(revision) || revision < 0) {
        throw recoveryError('Workflow checkpoint revision is invalid', 'MISSION_CHECKPOINT_MISMATCH');
      }
      if (revision > 0) {
        throw recoveryError(
          'Durable mission event history is missing for a checkpointed workflow',
          'MISSION_EVENT_HISTORY_MISSING'
        );
      }
      throw recoveryError(
        'Mission event history is required for legacy workflow recovery',
        'MISSION_EVENT_HISTORY_REQUIRED'
      );
    }

    return { events, snapshot: validatedSnapshot };
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
    const stableMetadata = value => {
      const metadata = { ...(value || {}) };
      delete metadata.fencingToken;
      delete metadata.projection;
      return metadata;
    };
    const comparable = value => ({
      state: value.state,
      steps: value.steps,
      retry: value.retry,
      cancelRequested: value.cancelRequested,
      deadlineAt: value.deadlineAt,
      recovery: value.recovery,
      compensation: value.compensation,
      input: value.input,
      metadata: stableMetadata(value.metadata)
    });
    return isDeepStrictEqual(comparable(snapshot), comparable(projected));
  }

  async reconcile(workflowId, tenantId = 'local') {
    const { events, snapshot: rawSnapshot } = await this._load(workflowId, tenantId);
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
      await this.workflowRepository.repair(repaired, {
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

  async reconstruct(workflowId, tenantId = 'local') {
    return (await this.reconcile(workflowId, tenantId)).workflow;
  }
}

module.exports = MissionEventRecovery;
