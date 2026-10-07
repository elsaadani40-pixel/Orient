const fs = require('fs');
const path = require('path');

class MemoryAuditRepository {
  constructor(filePath) {
    this.filePath = filePath;
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

  append(event) {
    const events = this.read();
    const record = {
      ...event,
      occurredAt: event.occurredAt || new Date().toISOString()
    };

    events.push(record);

    const temporaryFile = `${this.filePath}.tmp`;
    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(events, null, 2) + '\n',
      'utf8'
    );
    fs.renameSync(temporaryFile, this.filePath);

    return record;
  }

  findByMemoryId(memoryId, tenantId = 'default') {
    return this.read().filter(event =>
      event.tenantId === tenantId &&
      event.memoryId === memoryId
    );
  }
}

module.exports = MemoryAuditRepository;
