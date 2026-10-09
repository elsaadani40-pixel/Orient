const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class IdempotencyRepository {
  constructor(filePath) {
    if (!filePath) throw new TypeError('filePath is required');
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
        if (stale) {
          try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {}
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

  findByKey(key, { tenantId = null } = {}) {
    if (!key) return null;
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

  complete(key, result, { tenantId = null } = {}) {
    if (!key) throw new TypeError('key is required');
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

  fail(key, error, { tenantId = null } = {}) {
    if (!key) throw new TypeError('key is required');
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

  delete(key, { tenantId = null } = {}) {
    if (!key) return false;
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
