const crypto = require('crypto');
const { prepareStoragePath, initializeJsonFile, readJsonFile, writeAtomic, withDirectoryLock } = require('./json-file-boundary');

class ExecutionRepository {
  constructor(filePath, { lockTimeoutMs = 30_000 } = {}) {
    if (!filePath) {
      throw new TypeError('filePath is required');
    }
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
    initializeJsonFile(this.filePath, '[]\\n', this.directory, { allowUnsupported: true });
  }

  readRaw() {
    try {
      return readJsonFile(this.filePath, {
        label: 'Execution',
        rootType: 'array',
        emptyValue: () => []
      });
    } catch (error) {
      throw Object.assign(new Error(`Execution storage read failed: ${error.message}`), {
        code: error.code || 'EXECUTION_STORAGE_READ_FAILED',
        cause: error
      });
    }
  }

  normalize(execution) {
    if (!execution || typeof execution !== 'object') {
      throw new TypeError('execution must be an object');
    }

    const now = new Date().toISOString();

    return {
      id: execution.id || execution.executionId || crypto.randomUUID(),
      executionId:
        execution.executionId ||
        execution.id ||
        crypto.randomUUID(),
      requestId: execution.requestId || null,
      goalId: execution.goalId || null,
      parentExecutionId: execution.parentExecutionId || null,
      executionVersion: Number(execution.executionVersion || 1),
      status: execution.status || 'created',
      agentLifecycle: execution.agentLifecycle || 'created',
      startedAt: execution.startedAt || null,
      completedAt: execution.completedAt || null,
      input: execution.input ?? null,
      metadata:
        execution.metadata && typeof execution.metadata === 'object'
          ? { ...execution.metadata }
          : {},
      plan: execution.plan || null,
      tool: execution.tool || null,
      result: execution.result ?? null,
      currentStep: execution.currentStep ?? null,
      steps: Array.isArray(execution.steps)
        ? [...execution.steps]
        : [],
      observations: Array.isArray(execution.observations)
        ? [...execution.observations]
        : [],
      agentState: execution.agentState || null,
      events: Array.isArray(execution.events)
        ? [...execution.events]
        : [],
      updatedAt: execution.updatedAt || now,
      cancellationRequested: Boolean(execution.cancellationRequested),
      cancellationReason: execution.cancellationReason || null
    };
  }

  withLock(operation) {
    return withDirectoryLock(
      this.lockPath,
      this.lockTimeoutMs,
      'EXECUTION_STORAGE_LOCK_TIMEOUT',
      operation
    );
  }

  write(executions) {
    return writeAtomic(
      this.filePath,
      JSON.stringify(executions, null, 2) + '\\n',
      this.directory,
      { label: 'Execution', allowUnsupportedDirectoryFsync: true }
    );
  }

  findAll({ tenantId = null } = {}) {
    return this.readRaw().map(execution => this.normalize(execution))
      .filter(execution => !tenantId || execution.metadata?.tenantId === tenantId || (tenantId === 'local' && !execution.metadata?.tenantId));
  }

  findById(executionId, { tenantId = null } = {}) {
    return this.findAll({ tenantId }).find(
      execution => execution.executionId === executionId || execution.id === executionId
    ) || null;
  }

  findByGoalId(goalId, { tenantId = null } = {}) {
    if (!goalId) return [];
    return this.findAll({ tenantId }).filter(execution => execution.goalId === goalId);
  }

  insert(execution, { tenantId = null } = {}) {
    const normalized = this.normalize(execution);
    if (tenantId && normalized.metadata?.tenantId !== tenantId) {
      throw new Error('Execution tenant mismatch');
    }

    return this.withLock(() => {
      const executions = this.readRaw();

      if (
        executions.some(
          item =>
            item.executionId === normalized.executionId ||
            item.id === normalized.id
        )
      ) {
        throw new Error(
          `Execution already exists: ${normalized.executionId}`
        );
      }

      executions.unshift(normalized);
      this.write(executions);

      return normalized;
    });
  }

  update(executionId, patch, { tenantId = null } = {}) {
    if (!executionId) {
      throw new TypeError('executionId is required');
    }

    if (!patch || typeof patch !== 'object') {
      throw new TypeError('patch must be an object');
    }

    return this.withLock(() => {
      const executions = this.readRaw();

      const index = executions.findIndex(
        execution =>
          execution.executionId === executionId ||
          execution.id === executionId
      );

      if (index === -1) {
        return null;
      }

      const current = this.normalize(executions[index]);

      if (tenantId && current.metadata?.tenantId !== tenantId && !(tenantId === 'local' && !current.metadata?.tenantId)) return null;
      if (tenantId && patch.metadata?.tenantId && patch.metadata.tenantId !== tenantId) throw new Error('Execution tenant mismatch');

      // A durable cancellation request wins over a later terminal completion write.
      // This is the atomic outcome boundary for JSON persistence.
      if (current.cancellationRequested && ['completed', 'failed'].includes(patch.status)) {
        return current;
      }

      const updated = this.normalize({
        ...current,
        ...patch,
        ...(current.cancellationRequested ? {
          cancellationRequested: true,
          cancellationReason: current.cancellationReason || patch.cancellationReason || null
        } : {}),
        id: current.id,
        executionId: current.executionId,
        updatedAt: new Date().toISOString()
      });

      executions[index] = updated;
      this.write(executions);

      return updated;
    });
  }

  requestCancellation(executionId, reason = 'Execution cancellation requested', { tenantId = null } = {}) {
    if (!executionId) throw new TypeError('executionId is required');

    return this.withLock(() => {
      const executions = this.readRaw();
      const index = executions.findIndex(item => item.executionId === executionId || item.id === executionId);
      if (index === -1) return null;

      const current = this.normalize(executions[index]);
      if (tenantId && current.metadata?.tenantId !== tenantId && !(tenantId === 'local' && !current.metadata?.tenantId)) return null;

      if (['completed', 'failed', 'cancelled'].includes(current.status)) {
        return current;
      }

      const updated = this.normalize({
        ...current,
        cancellationRequested: true,
        cancellationReason: String(reason || 'Execution cancellation requested'),
        updatedAt: new Date().toISOString()
      });
      executions[index] = updated;
      this.write(executions);
      return updated;
    });
  }

  deleteById(executionId, { tenantId = null } = {}) {
    return this.withLock(() => {
      const executions = this.readRaw();

      const index = executions.findIndex(
        execution =>
          execution.executionId === executionId ||
          execution.id === executionId
      );

      if (index === -1) {
        return false;
      }

      const recordTenantId = executions[index]?.metadata?.tenantId || null;
      if (tenantId && recordTenantId !== tenantId && !(tenantId === 'local' && recordTenantId === null)) return false;

      executions.splice(index, 1);
      this.write(executions);

      return true;
    });
  }

  count() {
    return this.readRaw().length;
  }
}

module.exports = ExecutionRepository;
