const crypto = require('crypto');

const TYPE_MAP = Object.freeze({
  'workflow.step.started': 'workflow.step.running',
  'workflow.state.changed': 'workflow.state.changed',
  'workflow.approval.required': 'workflow.approval.required',
  'workflow.step.completed': 'workflow.step.completed',
  'workflow.step.failed': 'workflow.step.failed',
  'workflow.retry.scheduled': 'workflow.step.retry',
  'workflow.recovered': 'workflow.recovered',
  'workflow.compensation.started': 'workflow.compensation.started',
  'workflow.compensation.action': 'workflow.compensation.action',
  'workflow.compensation.completed': 'workflow.compensation.completed',
  'workflow.compensation.failed': 'workflow.compensation.failed'
});

class DurableMissionEventSink {
  constructor({ eventRepository, workflowRepository = null, tenantId = 'local', clock = () => new Date() } = {}) {
    if (!eventRepository || typeof eventRepository.appendMissionEvent !== 'function') {
      throw new TypeError('eventRepository with appendMissionEvent is required');
    }
    this.eventRepository = eventRepository;
    this.workflowRepository = workflowRepository;
    this.tenantId = tenantId || 'local';
    this.clock = clock;
  }

  _event(instance, type, data = {}, { eventId = null, timestamp = null } = {}) {
    return {
      id: eventId || crypto.randomUUID(),
      aggregateId: instance.workflowId,
      executionId: instance.workflowId,
      type,
      timestamp: timestamp || new Date(this.clock()).toISOString(),
      data: { ...data, tenantId: instance.tenantId || this.tenantId }
    };
  }

  async append(instance, type, data = {}, { persist = true, workerPrincipal = null, persistencePrincipal = null, eventId = null, timestamp = null } = {}) {
    const event = this._event(instance, type, data, { eventId, timestamp });
    let persisted;
    try {
      if (workerPrincipal && persistencePrincipal) {
        throw Object.assign(new Error('Mission event writes must use either worker lease authority or owner authority, not both'), {
          code: 'MISSION_EVENT_AUTHORITY_AMBIGUOUS'
        });
      }
      persisted = await this.eventRepository.appendMissionEvent(event, {
        tenantId: instance.tenantId || this.tenantId,
        ...(workerPrincipal ? { workerPrincipal } : {}),
        ...(persistencePrincipal ? { persistencePrincipal } : {})
      });
    } catch (error) {
      error.code = error.code || 'MISSION_EVENT_PERSISTENCE_FAILED';
      throw error;
    }
    if (persist && this.workflowRepository?.save) {
      try {
        await this.workflowRepository.save(instance, instance.tenantId || this.tenantId, {
          ...(workerPrincipal ? { workerPrincipal } : {}),
          ...(persistencePrincipal ? { persistencePrincipal } : {})
        });
      } catch (error) {
        error.code = error.code || 'MISSION_STATE_PERSISTENCE_FAILED_AFTER_EVENT';
        error.missionEventId = persisted.id;
        error.missionEventSequence = persisted.sequence;
        throw error;
      }
    }
    return persisted;
  }

  recordCreated(instance) {
    return this.append(instance, 'workflow.created', {
      workflowId: instance.workflowId,
      tenantId: instance.tenantId,
      userId: instance.userId,
      workspaceId: instance.workspaceId,
      createdAt: instance.createdAt,
      metadata: instance.metadata,
      definition: instance.definition.toJSON(),
      input: instance.input
    }, { persist: false });
  }

  recordState(instance, from, to) {
    return this.append(instance, 'workflow.state.changed', {
      from, to, deadlineAt: instance.deadlineAt, metadata: instance.metadata
    });
  }

  recordSnapshot(instance, reason = 'workflow_reconciliation', options = {}) {
    return this.append(instance, 'workflow.snapshot.replaced', {
      reason,
      snapshot: instance.toJSON()
    }, options);
  }

  recordWorkerEvent(instance, event) {
    const type = TYPE_MAP[event?.type];
    if (!type) return null;
    const payload = event.payload || {};
    return this.append(instance, type, {
      ...payload,
      ...(type === 'workflow.step.completed' ? {
        result: instance.steps[payload.stepId]?.result ?? null
      } : {}),
      ...(type === 'workflow.step.failed' ? {
        error: instance.steps[payload.stepId]?.error ?? payload.error ?? null
      } : {}),
      ...(type === 'workflow.step.running' ? {
        attempt: instance.steps[payload.stepId]?.attempts ?? payload.attempt ?? 0
      } : {})
    }, {
      workerPrincipal: event?.workerPrincipal || null,
      eventId: event?.eventId || null,
      timestamp: event?.timestamp || null
    });
  }

  async reconstruct(workflowId, tenantId = this.tenantId) {
    const events = await this.eventRepository.findByAggregateId(workflowId, { tenantId });
    if (!events.length) return null;
    const Projection = require('./mission-event-projection');
    return new Projection({ clock: this.clock }).rebuild(events);
  }
}

module.exports = DurableMissionEventSink;
