const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class IdempotencyRepository {
  constructor(filePath) {
    if (!filePath) {
      throw new TypeError('filePath is required');
    }

    this.filePath = filePath;
    this.ensureStorage();
  }

  ensureStorage() {
    const directory = path.dirname(this.filePath);

    fs.mkdirSync(directory, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '{}\n', 'utf8');
    }
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');

      if (!raw.trim()) {
        return {};
      }

      const parsed = JSON.parse(raw);

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        throw new Error('Storage root must be an object');
      }

      return parsed;
    } catch (error) {
      throw new Error(
        `Idempotency storage read failed: ${error.message}`
      );
    }
  }

  write(records) {
    const temporaryFile = `${this.filePath}.tmp`;

    try {
      fs.writeFileSync(
        temporaryFile,
        JSON.stringify(records, null, 2) + '\n',
        'utf8'
      );

      fs.renameSync(temporaryFile, this.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(temporaryFile)) {
          fs.unlinkSync(temporaryFile);
        }
      } catch {}

      throw new Error(
        `Idempotency storage write failed: ${error.message}`
      );
    }
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

    if (step === undefined || step === null) {
      throw new TypeError('step is required');
    }

    if (!tool) {
      throw new TypeError('tool is required');
    }

    return operationId || `${executionId}:plan-${planRevision}:step-${step}:${tool}`;
  }

  findByKey(key, { tenantId = null } = {}) {
    if (!key) {
      return null;
    }

    const record = this.read()[key] || null;
    return record && (!tenantId || record.tenantId === tenantId)
      ? record
      : null;
  }

  find({
    executionId,
    step,
    tool,
    planRevision = 1,
    operationId = null,
    tenantId = null
  } = {}) {
    const key = this.buildKey({
      executionId,
      step,
      tool,
      planRevision,
      operationId
    });

    return this.findByKey(key, { tenantId });
  }

  begin({
    executionId,
    step,
    tool,
    planRevision = 1,
    operationId = null
  } = {}) {
    const key = this.buildKey({
      executionId,
      step,
      tool,
      planRevision,
      operationId
    });

    const records = this.read();

    if (records[key]) {
      if (tenantId && records[key].tenantId !== tenantId) {
        throw new Error('Idempotency tenant mismatch');
      }
      return {
        created: false,
        key,
        record: records[key]
      };
    }

    const record = {
      id: crypto.randomUUID(),
      key,
      executionId,
      step,
      tool,
      planRevision,
      operationId,
      tenantId,
      status: 'running',
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null
    };

    records[key] = record;
    this.write(records);

    return {
      created: true,
      key,
      record
    };
  }

  complete(key, result, { tenantId = null } = {}) {
    if (!key) {
      throw new TypeError('key is required');
    }

    const records = this.read();
    const record = records[key];

    if (!record) {
      return null;
    }
    if (tenantId && record.tenantId !== tenantId) return null;

    record.status = 'completed';
    record.result = result ?? null;
    record.completedAt = new Date().toISOString();

    this.write(records);

    return record;
  }

  fail(key, error, { tenantId = null } = {}) {
    if (!key) {
      throw new TypeError('key is required');
    }

    const records = this.read();
    const record = records[key];

    if (!record) {
      return null;
    }
    if (tenantId && record.tenantId !== tenantId) return null;

    record.status = 'failed';
    record.error = {
      code: error?.code || 'EXECUTION_FAILED',
      message: error?.message || String(error || '')
    };
    record.completedAt = new Date().toISOString();

    this.write(records);

    return record;
  }

  delete(key, { tenantId = null } = {}) {
    if (!key) {
      return false;
    }

    const records = this.read();

    if (!records[key]) {
      return false;
    }
    if (tenantId && records[key].tenantId !== tenantId) return false;

    delete records[key];
    this.write(records);

    return true;
  }

  clear() {
    this.write({});
  }

  count() {
    return Object.keys(this.read()).length;
  }
}

module.exports = IdempotencyRepository;
