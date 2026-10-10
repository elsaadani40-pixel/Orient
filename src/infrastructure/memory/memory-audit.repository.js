const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MemoryAuditRepository {
  constructor(filePath, { eventSink = null } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    this.filePath = filePath;
    this.eventSink = eventSink;
    this.ensureStorage();
  }

  ensureStorage() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(this.filePath)) return;

    // Publish a complete initial document without exposing an empty file or
    // overwriting a concurrently-created audit log.
    const temporaryFile = `${this.filePath}.init.${process.pid}.${crypto.randomUUID()}`;
    let fd = null;
    try {
      fd = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(fd, '[]\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      try {
        fs.linkSync(temporaryFile, this.filePath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      this.syncDirectory(directory);
    } catch (error) {
      throw new Error(`Memory audit initialization failed: ${error.message}`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(temporaryFile); } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error(`Memory audit initialization cleanup failed: ${error.message}`);
        }
      }
    }
  }

  syncDirectory(directory) {
    let fd;
    try {
      fd = fs.openSync(directory, 'r');
      fs.fsyncSync(fd);
    } catch (error) {
      // Some supported platforms/filesystems do not allow directory fsync.
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  read() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) {
      throw Object.assign(new Error('Memory audit storage file is empty'), {
        code: 'MEMORY_AUDIT_CORRUPT'
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      const error = new Error(`Memory audit storage JSON is invalid: ${cause.message}`);
      error.code = 'MEMORY_AUDIT_CORRUPT';
      error.cause = cause;
      throw error;
    }
    if (!Array.isArray(parsed)) {
      throw Object.assign(new Error('Memory audit storage root must be an array'), {
        code: 'MEMORY_AUDIT_CORRUPT'
      });
    }
    return parsed;
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

    const directory = path.dirname(this.filePath);
    const temporaryFile = `${this.filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    let fd = null;
    try {
      fd = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(events, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temporaryFile, this.filePath);
      this.syncDirectory(directory);
    } catch (error) {
      throw new Error(`Memory audit write failed: ${error.message}`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(temporaryFile); } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error(`Memory audit temporary-file cleanup failed: ${error.message}`);
        }
      }
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
        // The audit record is already committed. Keep downstream delivery
        // failure observable without misreporting the durable append.
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
