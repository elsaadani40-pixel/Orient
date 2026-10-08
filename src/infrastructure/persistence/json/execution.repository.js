const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ExecutionRepository {
  constructor(filePath) {
    if (!filePath) {
      throw new TypeError('filePath is required');
    }

    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.ensureStorage();
  }

  ensureStorage() {
    const directory = path.dirname(this.filePath);

    fs.mkdirSync(directory, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]\n', 'utf8');
    }
  }

  readRaw() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');

      if (!raw.trim()) {
        return [];
      }

      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        throw new Error('Storage root must be an array');
      }

      return parsed;
    } catch (error) {
      throw new Error(`Execution storage read failed: ${error.message}`);
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
    const staleAfterMs = 30_000;
    const deadline = Date.now() + staleAfterMs;

    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }

        let stale = false;
        try {
          stale = Date.now() - fs.statSync(this.lockPath).mtimeMs > staleAfterMs;
        } catch (statError) {
          if (statError.code !== 'ENOENT') {
            throw statError;
          }
        }

        if (stale) {
          try {
            fs.rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          } catch (removeError) {
            if (removeError.code !== 'ENOENT') {
              throw removeError;
            }
          }
        }

        if (Date.now() >= deadline) {
          throw new Error('Execution storage lock acquisition timed out');
        }

        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }

    try {
      return operation();
    } finally {
      try {
        fs.rmSync(this.lockPath, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  write(executions) {
    const temporaryFile = `${this.filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;

    try {
      const payload = JSON.stringify(executions, null, 2) + '\n';
      const fd = fs.openSync(temporaryFile, 'w', 0o600);

      try {
        fs.writeFileSync(fd, payload, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      fs.renameSync(temporaryFile, this.filePath);

      try {
        const directoryFd = fs.openSync(path.dirname(this.filePath), 'r');
        try {
          fs.fsyncSync(directoryFd);
        } finally {
          fs.closeSync(directoryFd);
        }
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) {
          throw error;
        }
      }
    } catch (error) {
      try {
        if (fs.existsSync(temporaryFile)) {
          fs.unlinkSync(temporaryFile);
        }
      } catch {}

      throw new Error(`Execution storage write failed: ${error.message}`);
    }
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

      if (tenantId && executions[index]?.metadata?.tenantId !== tenantId) return false;

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
