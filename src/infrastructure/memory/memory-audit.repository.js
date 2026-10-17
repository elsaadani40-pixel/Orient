const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 10000;
const STALE_LOCK_MS = 30000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

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

      // Do not evict a live owner's lock. Reclaim only an abandoned lock
      // after the grace period, so another writer cannot overwrite active work.
      try {
        const statBefore = fs.statSync(lockPath);
        const raw = fs.readFileSync(lockPath, 'utf8');
        let owner = null;
        try { owner = JSON.parse(raw); } catch {}
        const oldEnough = Date.now() - statBefore.mtimeMs > STALE_LOCK_MS;
        const abandoned = owner && !processIsAlive(Number(owner.pid));
        if (oldEnough && (abandoned || !owner)) {
          const statAfter = fs.statSync(lockPath);
          const rawAfter = fs.readFileSync(lockPath, 'utf8');
          if (statBefore.ino === statAfter.ino && raw === rawAfter) {
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (error.code !== 'EACCES') throw error;
      }

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
      fs.writeFileSync(
        temporaryFile,
        JSON.stringify(events, null, 2) + '\n',
        { encoding: 'utf8', mode: 0o600 }
      );
      fs.renameSync(temporaryFile, this.filePath);
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
