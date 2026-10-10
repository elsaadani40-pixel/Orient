const fs = require('fs');
const path = require('path');

class MemoryAuditRepository {
  constructor(filePath, { eventSink = null } = {}) {
    this.filePath = filePath;
    this.eventSink = eventSink;
    this.ensureStorage();
  }

  ensureStorage() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]\n', 'utf8');
    }
  }

  read() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  setEventSink(eventSink) {
    this.eventSink = typeof eventSink === 'function' ? eventSink : null;
    return this;
  }

  append(event) {
    const events = this.read();
    const record = {
      ...event,
      occurredAt: event.occurredAt || new Date().toISOString()
    };
    events.push(record);

    const temporaryFile = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(
        temporaryFile,
        JSON.stringify(events, null, 2) + '\n',
        'utf8'
      );
      fs.renameSync(temporaryFile, this.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      } catch {}
      throw new Error(`Memory audit write failed: ${error.message}`);
    }

    if (this.eventSink) {
      const eventTypeByAction = {
        'memory.created': 'memory.created',
        'memory.reinforced': 'memory.reinforced',
        'memory.conflict.resolved': 'memory.conflict.resolved',
        'memory.accessed': 'memory.accessed',
        'memory.consolidated': 'memory.consolidated',
        'memory.archived': 'memory.archived'
      };
      try {
        this.eventSink({
          ...record,
          type: record.type || eventTypeByAction[record.action] || 'memory.updated'
        });
        this.lastEventSinkError = null;
      } catch (error) {
        // The audit record has already been durably written. Propagating a
        // downstream publication error would make callers compensate a memory
        // mutation even though its audit event is committed. Keep the durable
        // audit log authoritative and retain the delivery failure for health
        // reporting/replay; do not misreport the append as uncommitted.
        this.lastEventSinkError = error;
      }
    }

    return record;
  }

  findByMemoryId(memoryId, tenantId = 'local', scope = null) {
    return this.read().filter(event =>
      event.tenantId === tenantId &&
      event.memoryId === memoryId &&
      (!scope || event.scope === scope || (!event.scope && scope === 'personal'))
    );
  }
}

module.exports = MemoryAuditRepository;
