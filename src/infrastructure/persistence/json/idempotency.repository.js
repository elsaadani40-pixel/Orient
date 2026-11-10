const crypto = require('crypto');
const { prepareStoragePath, initializeJsonFile, readJsonFile, writeAtomic, withDirectoryLock } = require('./json-file-boundary');

class IdempotencyRepository {
  constructor(filePath, { lockTimeoutMs = 30000 } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }
    this.lockTimeoutMs = lockTimeoutMs;
    this.filePath = filePath;
    this.ensureStorage();
  }

  ensureStorage() {
    const storage = prepareStoragePath(this.filePath);
    this.filePath = storage.filePath;
    this.directory = storage.directory;
    this.lockPath = storage.lockPath;
    initializeJsonFile(this.filePath, '{}\\n', this.directory);
  }

  read() {
    try {
      const parsed = readJsonFile(this.filePath, {
        label: 'Idempotency',
        rootType: 'object',
        emptyValue: () => Object.create(null)
      });
      return Object.assign(Object.create(null), parsed);
    } catch (error) {
      throw Object.assign(new Error('Idempotency storage read failed: ' + error.message), {
        code: error.code || 'IDEMPOTENCY_STORAGE_READ_FAILED',
        cause: error
      });
    }
  }

  write(records) {
    return writeAtomic(
      this.filePath,
      JSON.stringify(records, null, 2) + '\\n',
      this.directory,
      { label: 'Idempotency' }
    );
  }

  withLock(operation) {
    return withDirectoryLock(
      this.lockPath,
      this.lockTimeoutMs,
      'IDEMPOTENCY_STORAGE_LOCK_TIMEOUT',
      operation
    );
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
    const records = this.read();
    const record = Object.hasOwn(records, key) ? records[key] : null;
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
      if (Object.hasOwn(records, key)) {
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
      const record = Object.hasOwn(records, key) ? records[key] : null;
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
      if (!Object.hasOwn(records, key) || !this.tenantMatches(records[key], tenantId)) return false;
      delete records[key];
      this.write(records);
      return true;
    });
  }

  clear() {
    return this.withLock(() => this.write(Object.create(null)));
  }

  count() {
    return Object.keys(this.read()).length;
  }
}

module.exports = IdempotencyRepository;
