class IdempotencyStore {
  constructor({ repository = null } = {}) {
    this.repository = repository;
    this.records = new Map();
  }

  tenantScope(tenantId = null) {
    return tenantId || 'local';
  }

  storageKey(key, tenantId = null) {
    return JSON.stringify([this.tenantScope(tenantId), key]);
  }

  terminalConflict(message) {
    const error = new Error(message);
    error.code = 'IDEMPOTENCY_TERMINAL_CONFLICT';
    error.status = 409;
    return error;
  }

  buildKey({
    executionId,
    step,
    tool,
    planRevision = 1,
    operationId = null,
    tenantId = null
  } = {}) {
    if (!executionId) {
      throw new TypeError('executionId is required');
    }
    if (!Number.isInteger(step) || step < 1) {
      throw new TypeError('step must be a positive integer');
    }
    if (!tool || typeof tool !== 'string') {
      throw new TypeError('tool is required');
    }
    return operationId || `${executionId}:plan-${planRevision}:step-${step}:${tool}`;
  }

  has(key, tenantId = null) {
    return Boolean(this.get(key, tenantId));
  }

  get(key, tenantId = null) {
    if (this.repository) {
      return this.repository.findByKey(key, { tenantId });
    }
    return this.records.get(this.storageKey(key, tenantId)) || null;
  }

  begin({
    executionId,
    step,
    tool,
    planRevision = 1,
    operationId = null,
    tenantId = null
  } = {}) {
    const key = this.buildKey({
      executionId, step, tool, planRevision, operationId, tenantId
    });

    if (this.repository) {
      return this.repository.begin({
        executionId, step, tool, planRevision, operationId, tenantId
      });
    }

    const scopedKey = this.storageKey(key, tenantId);
    const existing = this.records.get(scopedKey);
    if (existing) return { created: false, key, record: existing };

    const record = {
      key, executionId, step, tool, planRevision, operationId, tenantId,
      status: 'running', result: null, error: null,
      startedAt: new Date().toISOString(), completedAt: null
    };
    this.records.set(scopedKey, record);
    return { created: true, key, record };
  }

  complete(key, result, tenantId = null) {
    if (this.repository) {
      const record = this.repository.complete(key, result, { tenantId });
      if (!record) throw new Error('Idempotency record not found');
      return record;
    }

    const record = this.get(key, tenantId);
    if (!record) throw new Error('Idempotency record not found');
    const normalizedResult = result ?? null;
    if (record.status === 'completed') {
      if (JSON.stringify(record.result) !== JSON.stringify(normalizedResult)) {
        throw this.terminalConflict('Idempotency record is already completed with a different result');
      }
      return record;
    }
    if (record.status !== 'running') {
      throw this.terminalConflict('Idempotency record is not running');
    }
    record.status = 'completed';
    record.result = normalizedResult;
    record.completedAt = new Date().toISOString();
    return record;
  }

  fail(key, error, tenantId = null) {
    if (this.repository) {
      const record = this.repository.fail(key, error, { tenantId });
      if (!record) throw new Error('Idempotency record not found');
      return record;
    }

    const record = this.get(key, tenantId);
    if (!record) throw new Error('Idempotency record not found');
    if (record.status === 'failed') return record;
    if (record.status === 'completed') {
      throw this.terminalConflict('Completed idempotency record cannot be failed');
    }
    if (record.status !== 'running') {
      throw this.terminalConflict('Idempotency record is not running');
    }
    record.status = 'failed';
    record.error = {
      code: error?.code || 'EXECUTION_FAILED',
      message: error?.message || String(error || '')
    };
    record.completedAt = new Date().toISOString();
    return record;
  }

  delete(key, tenantId = null) {
    if (this.repository) return this.repository.delete(key, { tenantId });
    return this.records.delete(this.storageKey(key, tenantId));
  }

  clear() {
    if (this.repository) return this.repository.clear();
    this.records.clear();
  }

  size() {
    if (this.repository) return this.repository.count();
    return this.records.size;
  }
}

module.exports = IdempotencyStore;
