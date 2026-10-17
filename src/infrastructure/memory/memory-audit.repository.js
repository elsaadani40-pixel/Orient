const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 10000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

class MemoryAuditRepository {
  constructor(filePath, { eventSink = null } = {}) {
    this.filePath = filePath;
    this.eventSink = eventSink;
    this.ensureStorage();
  }

  ensureStorage() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      // Exclusive creation prevents concurrent first-time writers from
      // truncating the log before either writer acquires the append lock.
      const descriptor = fs.openSync(this.filePath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, '[]\n', 'utf8');
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
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

  acquireLock() {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      try {
        const descriptor = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(descriptor, JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
            token: crypto.randomUUID()
          }), 'utf8');
        } finally {
          fs.closeSync(descriptor);
        }
        return lockPath;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw new Error(`Memory audit lock failed: ${error.message}`);
        }
      }

      // Never unlink a lock based on a check-then-delete sequence: another
      // process could acquire the path between those operations. If a process
      // dies while holding the lock, fail closed after the bounded timeout.

      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for memory audit write lock');
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  append(event) {
    const record = {
      ...event,
      occurredAt: event.occurredAt || new Date().toISOString()
    };
    const lockPath = this.acquireLock();
    const temporaryFile = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;

    try {
      const events = this.read();
      events.push(record);
      const descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(events, null, 2) + '\n', 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryFile, this.filePath);

      // Persist the rename where directory fsync is supported. Some platforms
      // do not allow opening directories; only those documented limitations
      // are ignored, while unexpected I/O failures remain visible.
      let directoryDescriptor;
      try {
        directoryDescriptor = fs.openSync(path.dirname(this.filePath), 'r');
        fs.fsyncSync(directoryDescriptor);
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) {
          throw error;
        }
      } finally {
        if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      try {
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      } catch {}
      throw new Error(`Memory audit write failed: ${error.message}`);
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
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
      this.eventSink({
        ...record,
        type: record.type || eventTypeByAction[record.action] || 'memory.updated'
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
