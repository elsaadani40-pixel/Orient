const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class EventRepository {
  constructor(filePath) {
    if (!filePath) {
      throw new TypeError('filePath is required');
    }

    this.filePath = filePath;
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

  normalize(event) {
    if (!event || typeof event !== 'object') {
      throw new TypeError('event must be an object');
    }

    return {
      id: event.id || crypto.randomUUID(),
      type: event.type,
      executionId: event.executionId || null,
      goalId: event.goalId || null,
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
    const events = this.read();

    if (!events.some(event => event.id === normalized.id)) {
      events.push(normalized);
      this.write(events);
    }

    return normalized;
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

    const current = this.read();
    const existingIds = new Set(
      current.map(event => event.id)
    );

    const unique = normalized.filter(
      event => {
        if (existingIds.has(event.id)) return false;
        existingIds.add(event.id);
        return true;
      }
    );

    if (unique.length) {
      current.push(...unique);
      this.write(current);
    }

    return unique;
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

  findByType(type, { tenantId = null } = {}) {
    if (!type) return [];
    return this.findAll({ tenantId }).filter(event => event.type === type);
  }

  count() {
    return this.read().length;
  }

  clear() {
    this.write([]);
  }
}

module.exports = EventRepository;
