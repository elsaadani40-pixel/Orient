class IdempotencyStore {
  constructor({ repository = null } = {}) {
    this.repository = repository;
    this.records = new Map();
  }

  buildKey({
    executionId,
    step,
    tool,
    planRevision = 1,
    operationId = null
  } = {}) {
    if (!executionId) {
      throw new TypeError(
        'executionId is required'
      );
    }

    if (!Number.isInteger(step) || step < 1) {
      throw new TypeError(
        'step must be a positive integer'
      );
    }

    if (!tool || typeof tool !== 'string') {
      throw new TypeError(
        'tool is required'
      );
    }

    return operationId || `${executionId}:plan-${planRevision}:step-${step}:${tool}`;
  }

  has(key) {
    return Boolean(this.get(key));
  }

  get(key) {
    if (this.repository) {
      return this.repository.findByKey(key);
    }

    return this.records.get(key) || null;
  }

  begin({
    executionId,
    step,
    tool,
    planRevision = 1,
    operationId = null
  } = {}) {
    const key =
      this.buildKey({
        executionId,
        step,
        tool,
        planRevision,
        operationId
      });

    if (this.repository) {
      return this.repository.begin({
        executionId,
        step,
        tool,
        planRevision
      });
    }

    const existing =
      this.records.get(key);

    if (existing) {
      return {
        created: false,
        key,
        record: existing
      };
    }

    const record = {
      key,
      executionId,
      step,
      tool,
      planRevision,
      operationId,
      status: 'running',
      result: null,
      error: null,
      startedAt:
        new Date().toISOString(),
      completedAt: null
    };

    this.records.set(
      key,
      record
    );

    return {
      created: true,
      key,
      record
    };
  }

  complete(
    key,
    result
  ) {
    if (this.repository) {
      const record =
        this.repository.complete(
          key,
          result
        );

      if (!record) {
        throw new Error(
          'Idempotency record not found'
        );
      }

      return record;
    }

    const record =
      this.records.get(key);

    if (!record) {
      throw new Error(
        'Idempotency record not found'
      );
    }

    record.status = 'completed';
    record.result = result;
    record.completedAt =
      new Date().toISOString();

    return record;
  }

  fail(
    key,
    error
  ) {
    if (this.repository) {
      const record =
        this.repository.fail(
          key,
          error
        );

      if (!record) {
        throw new Error(
          'Idempotency record not found'
        );
      }

      return record;
    }

    const record =
      this.records.get(key);

    if (!record) {
      throw new Error(
        'Idempotency record not found'
      );
    }

    record.status = 'failed';

    record.error = {
      code:
        error?.code ||
        'EXECUTION_FAILED',
      message:
        error?.message ||
        String(error || '')
    };

    record.completedAt =
      new Date().toISOString();

    return record;
  }

  delete(key) {
    if (this.repository) {
      return this.repository.delete(key);
    }

    return this.records.delete(key);
  }

  clear() {
    if (this.repository) {
      return this.repository.clear();
    }

    this.records.clear();
  }

  size() {
    if (this.repository) {
      return this.repository.count();
    }

    return this.records.size;
  }
}

module.exports = IdempotencyStore;
