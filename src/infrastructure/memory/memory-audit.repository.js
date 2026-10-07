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
      this.eventSink({
        ...record,
        type: record.type || `memory.${String(record.action || 'updated').replace(/^memory\\./, '').replace(/\\./g, '_')}`
      });
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
