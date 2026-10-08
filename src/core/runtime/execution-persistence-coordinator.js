const crypto = require('crypto');

class ExecutionPersistenceCoordinator {
  constructor({ persistence = null, tenantId = 'local', persistedEventOffsets = null } = {}) {
    this.persistence = persistence;
    this.tenantId = tenantId || 'local';
    this.persistedEventOffsets = persistedEventOffsets || new WeakMap();
  }

  persistEvents(context) {
    if (!this.persistence?.events || !context) return [];

    const events = Array.isArray(context.events) ? context.events : [];
    if (!events.length) return [];

    const scopedEvents = events.map(event => ({
      ...event,
      data: {
        ...(event.data || {}),
        tenantId: context.tenantId
      }
    }));

    return this.persistence.events.appendMany(scopedEvents, { tenantId: this.tenantId });
  }

  async persistExecution(context, mode = 'update') {
    if (!this.persistence?.executions) return null;

    const snapshot = context.snapshot();
    if (snapshot.tenantId && snapshot.tenantId !== this.tenantId) {
      throw Object.assign(
        new Error('Execution tenant does not match runtime tenant'),
        { code: 'TENANT_CONTEXT_MISMATCH' }
      );
    }

    if (mode === 'insert') {
      return this.persistence.executions.insert(snapshot, { tenantId: this.tenantId });
    }

    return this.persistence.executions.update(
      snapshot.executionId,
      snapshot,
      { tenantId: this.tenantId }
    );
  }

  async checkpoint(context, mode = 'update', reason = 'runtime_checkpoint') {
    if (!context) throw new TypeError('context is required');

    const snapshot = (await this.persistExecution(context, mode)) || context.snapshot();
    const events = Array.isArray(context.events) ? context.events : [];
    let offset = this.persistedEventOffsets.get(context) || 0;

    if (offset > events.length) offset = 0;

    const pendingEvents = events.slice(offset).map(event => ({
      ...event,
      data: {
        ...(event.data || {}),
        tenantId: context.tenantId
      }
    }));

    let persistedEvents = [];
    if (pendingEvents.length && this.persistence?.events?.appendMany) {
      persistedEvents = await this.persistence.events.appendMany(
        pendingEvents,
        { tenantId: this.tenantId }
      );
    }

    this.persistedEventOffsets.set(context, events.length);

    let durableCheckpoint = null;
    if (this.persistence?.checkpoints?.save) {
      durableCheckpoint = this.persistence.checkpoints.save(
        snapshot,
        { reason, tenantId: this.tenantId }
      );
    }

    const eventsResult = persistedEvents?.then ? await persistedEvents : persistedEvents;
    const checkpointResult = durableCheckpoint?.then ? await durableCheckpoint : durableCheckpoint;

    return {
      snapshot,
      events: eventsResult,
      eventCount: eventsResult.length,
      checkpoint: checkpointResult
    };
  }
}

module.exports = ExecutionPersistenceCoordinator;
