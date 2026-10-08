const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class EventRepository {
  constructor(filePath) {
    if (!filePath) {
      throw new TypeError('filePath is required');
    }

    this.filePath = filePath;
    this.lockPath = filePath + '.lock';
    this.ensureStorage();
  }

  ensureStorage() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]\n', 'utf8');
    }
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');

      if (!raw.trim()) {
        return [];
      }

      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        throw new Error('Storage root must be an array');
      }

      return parsed;
    } catch (error) {
      throw new Error(`Event storage read failed: ${error.message}`);
    }
  }

  write(events) {
    const temporaryFile = `${this.filePath}.tmp`;

    try {
      fs.writeFileSync(
        temporaryFile,
        JSON.stringify(events, null, 2) + '\n',
        'utf8'
      );

      fs.renameSync(temporaryFile, this.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(temporaryFile)) {
          fs.unlinkSync(temporaryFile);
        }
      } catch {}

      throw new Error(`Event storage write failed: ${error.message}`);
    }
  }

  withLock(operation) {
    const timeoutMs = 30000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        try { return operation(); }
        finally { try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {} }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stale = false;
        try { stale = Date.now() - fs.statSync(this.lockPath).mtimeMs > timeoutMs; }
        catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        if (stale) { try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {} continue; }
        if (Date.now() >= deadline) {
          const lockError = new Error('Event storage lock timeout');
          lockError.code = 'EVENT_STORAGE_LOCK_TIMEOUT';
          throw lockError;
        }
        const wait = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(wait), 0, 0, 5);
      }
    }
  }

  normalize(event) {
    if (!event || typeof event !== 'object') {
      throw new TypeError('event must be an object');
    }

    return {
      id: event.id || crypto.randomUUID(),
      type: event.type,
      executionId: event.executionId || null,
      goalId: event.goalId || null,
      aggregateId: event.aggregateId || event.workflowId || null,
      sequence: event.sequence == null ? null : Number(event.sequence),
      timestamp: event.timestamp || new Date().toISOString(),
      data:
        event.data && typeof event.data === 'object'
          ? { ...event.data }
          : {}
    };
  }

  append(event, { tenantId = null } = {}) {
    const normalized = this.normalize(event);
    if (tenantId && normalized.data?.tenantId && normalized.data.tenantId !== tenantId) throw new Error('Event tenant mismatch');
    if (tenantId && !normalized.data?.tenantId) normalized.data.tenantId = tenantId;
    return this.withLock(() => {
      const events = this.read();
      if (!events.some(event => event.id === normalized.id)) {
        events.push(normalized);
        this.write(events);
      }
      return normalized;
    });
  }

  appendMany(events, { tenantId = null } = {}) {
    if (!Array.isArray(events)) {
      throw new TypeError('events must be an array');
    }

    if (!events.length) {
      return [];
    }

    const normalized = events.map(event => {
      const item = this.normalize(event);
      if (tenantId && item.data?.tenantId && item.data.tenantId !== tenantId) throw new Error('Event tenant mismatch');
      if (tenantId && !item.data?.tenantId) item.data.tenantId = tenantId;
      return item;
    });

    return this.withLock(() => {
      const current = this.read();
      const existingIds = new Set(current.map(event => event.id));
      const unique = normalized.filter(event => {
        if (existingIds.has(event.id)) return false;
        existingIds.add(event.id);
        return true;
      });
      if (unique.length) {
        current.push(...unique);
        this.write(current);
      }
      return unique;
    });
  }

  findAll({ tenantId = null } = {}) {
    return this.read().filter(event => !tenantId || event.data?.tenantId === tenantId || (tenantId === 'local' && !event.data?.tenantId));
  }

  findByExecutionId(executionId, { tenantId = null } = {}) {
    if (!executionId) return [];
    return this.findAll({ tenantId }).filter(event => event.executionId === executionId);
  }

  findByGoalId(goalId, { tenantId = null } = {}) {
    if (!goalId) return [];
    return this.findAll({ tenantId }).filter(event => event.goalId === goalId);
  }

  appendMissionEvent(event, { tenantId = null } = {}) {
    if (!event?.aggregateId) throw new TypeError('aggregateId is required');
    return this.withLock(() => {
      const current = this.read();
      const existing = current.find(item => item.id === event.id);
      if (existing) return existing;
      const normalized = this.normalize({ ...event });
      if (tenantId && normalized.data?.tenantId && normalized.data.tenantId !== tenantId) throw new Error('Event tenant mismatch');
      if (tenantId && !normalized.data?.tenantId) normalized.data.tenantId = tenantId;
      const aggregateEvents = current.filter(item => item.aggregateId === normalized.aggregateId);
      const expected = aggregateEvents.length ? Math.max(...aggregateEvents.map(item => Number(item.sequence) || 0)) + 1 : 1;
      if (normalized.sequence != null && normalized.sequence !== expected) {
        const error = new Error('Mission event sequence conflict');
        error.code = 'MISSION_EVENT_SEQUENCE_CONFLICT';
        throw error;
      }
      normalized.sequence = expected;
      current.push(normalized);
      this.write(current);
      return normalized;
    });
  }

  findByAggregateId(aggregateId, { tenantId = null } = {}) {
    if (!aggregateId) return [];
    return this.findAll({ tenantId })
      .filter(event => event.aggregateId === aggregateId)
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }

  findByType(type, { tenantId = null } = {}) {
    if (!type) return [];
    return this.findAll({ tenantId }).filter(event => event.type === type);
  }

  count() {
    return this.read().length;
  }

  clear() {
    this.withLock(() => this.write([]));
  }
}

module.exports = EventRepository;
