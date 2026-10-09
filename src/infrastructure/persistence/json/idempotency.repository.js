const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class IdempotencyRepository {
  constructor(filePath, { lockTimeoutMs = 30000 } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }
    this.lockTimeoutMs = lockTimeoutMs;
    this.filePath = filePath;
    this.lockPath = filePath + '.lock';
    this.ensureStorage();
  }

  ensureStorage() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    try {
      const fd = fs.openSync(this.filePath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, '{}\n', 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Storage root must be an object');
      }
      return parsed;
    } catch (error) {
      throw new Error('Idempotency storage read failed: ' + error.message);
    }
  }

  write(records) {
    const directory = path.dirname(this.filePath);
    const temporaryFile = this.filePath + '.tmp.' + process.pid + '.' + crypto.randomUUID();
    let fileDescriptor = null;
    try {
      fileDescriptor = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(fileDescriptor, JSON.stringify(records, null, 2) + '\n', 'utf8');
      // Persist the new contents before making the atomic rename visible.
      fs.fsyncSync(fileDescriptor);
      fs.closeSync(fileDescriptor);
      fileDescriptor = null;

      fs.renameSync(temporaryFile, this.filePath);

      // Persist the directory entry update as well, so the rename survives a
      // sudden process/host crash on filesystems that support directory fsync.
      const directoryDescriptor = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (fileDescriptor !== null) {
        try { fs.closeSync(fileDescriptor); } catch {}
      }
      try { if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile); } catch {}
      throw new Error('Idempotency storage write failed: ' + error.message);
    }
  }

  withLock(operation) {
    const timeoutMs = this.lockTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const hostname = require('os').hostname();
    const token = crypto.randomUUID();

    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        const owner = {
          token,
          pid: process.pid,
          hostname,
          acquiredAt: new Date().toISOString()
        };
        try {
          // A lock without owner metadata is never reclaimed by age alone.
          // This avoids stealing a live lock during a slow fsync/write.
          fs.writeFileSync(
            path.join(this.lockPath, 'owner.json'),
            JSON.stringify(owner) + '\\n',
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
          );
          return operation();
        } finally {
          try {
            const ownerPath = path.join(this.lockPath, 'owner.json');
            const currentOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
            if (currentOwner.token === token) {
              fs.rmSync(this.lockPath, { recursive: true, force: true });
            }
          } catch (cleanupError) {
            // Never delete a lock whose ownership cannot be proven.
          }
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;

        let owner = null;
        try {
          owner = JSON.parse(fs.readFileSync(path.join(this.lockPath, 'owner.json'), 'utf8'));
        } catch (ownerError) {
          if (ownerError.code !== 'ENOENT' && !(ownerError instanceof SyntaxError)) throw ownerError;
        }

        // Only reclaim a lock when its recorded process is verifiably dead on
        // this host. Age is diagnostic only, never evidence of process death.
        let stale = false;
        if (owner && owner.hostname === hostname && Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (processError) {
            stale = processError.code === 'ESRCH';
            if (processError.code === 'EPERM') stale = false;
            else if (processError.code !== 'ESRCH') throw processError;
          }
        }

        if (stale) {
          // Rename first so concurrent reclaimers cannot all recursively delete
          // the same lock path. Recheck the moved owner before removing it.
          const quarantinePath = this.lockPath + '.stale.' + crypto.randomUUID();
          try {
            fs.renameSync(this.lockPath, quarantinePath);
            let movedOwner = null;
            try {
              movedOwner = JSON.parse(fs.readFileSync(path.join(quarantinePath, 'owner.json'), 'utf8'));
            } catch {}
            if (movedOwner && movedOwner.token === owner.token &&
                movedOwner.pid === owner.pid && movedOwner.hostname === owner.hostname) {
              fs.rmSync(quarantinePath, { recursive: true, force: true });
            } else {
              // Ownership changed between inspection and rename. Restore only
              // if the canonical lock path is still vacant; otherwise preserve
              // the quarantined directory for safe manual recovery.
              try { fs.renameSync(quarantinePath, this.lockPath); } catch {}
            }
          } catch (reclaimError) {
            if (reclaimError.code !== 'ENOENT' && reclaimError.code !== 'EEXIST') throw reclaimError;
          }
          continue;
        }

        if (Date.now() >= deadline) {
          const lockError = new Error('Idempotency storage lock timeout');
          lockError.code = 'IDEMPOTENCY_STORAGE_LOCK_TIMEOUT';
          throw lockError;
        }
        const wait = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(wait), 0, 0, 5);
      }
    }
  }

  normalizeTenantId(tenantOptions = null) {
    // AgentLoop passes the canonical tenant as a string; public repository
    // callers historically pass { tenantId }.
    if (typeof tenantOptions === 'string') return tenantOptions || null;
    return tenantOptions && typeof tenantOptions === 'object'
      ? tenantOptions.tenantId || null
      : null;
  }

  buildKey({ executionId, step, tool, planRevision = 1, operationId = null } = {}) {
    if (!executionId) throw new TypeError('executionId is required');
    if (step === undefined || step === null) throw new TypeError('step is required');
    if (!tool) throw new TypeError('tool is required');
    return operationId || executionId + ':plan-' + planRevision + ':step-' + step + ':' + tool;
  }

  tenantMatches(record, tenantId = null) {
    const recordTenantId = record?.tenantId || null;
    const requestedTenantId = tenantId || null;
    // Before canonical local-tenant persistence, local operations were stored
    // without tenantId. Keep those records recoverable only through local scope.
    return recordTenantId === requestedTenantId ||
      (requestedTenantId === 'local' && recordTenantId === null);
  }

  findByKey(key, tenantOptions = null) {
    if (!key) return null;
    const tenantId = this.normalizeTenantId(tenantOptions);
    const record = this.read()[key] || null;
    return record && this.tenantMatches(record, tenantId)
      ? record : null;
  }

  find(args = {}) {
    const key = this.buildKey(args);
    return this.findByKey(key, { tenantId: args.tenantId || null });
  }

  begin({ executionId, step, tool, planRevision = 1, operationId = null, tenantId = null } = {}) {
    const key = this.buildKey({ executionId, step, tool, planRevision, operationId });
    return this.withLock(() => {
      const records = this.read();
      if (records[key]) {
        if (!this.tenantMatches(records[key], tenantId)) {
          const error = new Error('Idempotency tenant mismatch');
          error.code = 'IDEMPOTENCY_TENANT_MISMATCH';
          error.status = 403;
          throw error;
        }
        return { created: false, key, record: records[key] };
      }
      const record = {
        id: crypto.randomUUID(), key, executionId, step, tool, planRevision, operationId, tenantId,
        status: 'running', result: null, error: null,
        startedAt: new Date().toISOString(), completedAt: null
      };
      records[key] = record;
      this.write(records);
      return { created: true, key, record };
    });
  }

  complete(key, result, tenantOptions = null) {
    if (!key) throw new TypeError('key is required');
    const tenantId = this.normalizeTenantId(tenantOptions);
    return this.withLock(() => {
      const records = this.read();
      const record = records[key];
      if (!record || !this.tenantMatches(record, tenantId)) return null;
      if (record.status === 'completed') {
        if (JSON.stringify(record.result) !== JSON.stringify(result ?? null)) {
          const error = new Error('Idempotency record is already completed with a different result');
          error.code = 'IDEMPOTENCY_TERMINAL_CONFLICT';
          error.status = 409;
          throw error;
        }
        return record;
      }
      if (record.status !== 'running') {
        const error = new Error('Idempotency record is not running');
        error.code = 'IDEMPOTENCY_TERMINAL_CONFLICT';
        error.status = 409;
        throw error;
      }
      record.status = 'completed';
      record.result = result ?? null;
      record.completedAt = new Date().toISOString();
      this.write(records);
      return record;
    });
  }

  fail(key, error, tenantOptions = null) {
    if (!key) throw new TypeError('key is required');
    const tenantId = this.normalizeTenantId(tenantOptions);
    return this.withLock(() => {
      const records = this.read();
      const record = records[key];
      if (!record || !this.tenantMatches(record, tenantId)) return null;
      if (record.status === 'failed') return record;
      if (record.status === 'completed') {
        const error = new Error('Completed idempotency record cannot be failed');
        error.code = 'IDEMPOTENCY_TERMINAL_CONFLICT';
        error.status = 409;
        throw error;
      }
      if (record.status !== 'running') {
        const error = new Error('Idempotency record is not running');
        error.code = 'IDEMPOTENCY_TERMINAL_CONFLICT';
        error.status = 409;
        throw error;
      }
      record.status = 'failed';
      record.error = {
        code: error?.code || 'EXECUTION_FAILED',
        message: error?.message || String(error || '')
      };
      record.completedAt = new Date().toISOString();
      this.write(records);
      return record;
    });
  }

  delete(key, tenantOptions = null) {
    if (!key) return false;
    const tenantId = this.normalizeTenantId(tenantOptions);
    return this.withLock(() => {
      const records = this.read();
      if (!records[key] || !this.tenantMatches(records[key], tenantId)) return false;
      delete records[key];
      this.write(records);
      return true;
    });
  }

  clear() {
    return this.withLock(() => this.write({}));
  }

  count() {
    return Object.keys(this.read()).length;
  }
}

module.exports = IdempotencyRepository;
