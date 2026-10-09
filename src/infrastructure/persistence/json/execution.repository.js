const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    const timeoutMs = this.lockTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const hostname = require('os').hostname();

    while (true) {
      const token = crypto.randomUUID();
      try {
        fs.mkdirSync(this.lockPath);
        const owner = {
          token,
          pid: process.pid,
          hostname,
          acquiredAt: new Date().toISOString()
        };

        try {
          fs.writeFileSync(
            path.join(this.lockPath, 'owner.json'),
            JSON.stringify(owner) + '\n',
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
          );
        } catch (error) {
          // We created this directory, and without owner metadata nobody can
          // safely reclaim it. Remove our incomplete acquisition immediately.
          try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {}
          throw error;
        }

        try {
          return operation();
        } finally {
          try {
            const currentOwner = JSON.parse(
              fs.readFileSync(path.join(this.lockPath, 'owner.json'), 'utf8')
            );
            if (currentOwner.token === token) {
              fs.rmSync(this.lockPath, { recursive: true, force: true });
            }
          } catch (cleanupError) {
            // Preserve locks when ownership cannot be verified.
          }
        }
      } catch (error) {
        // Only mkdir contention is handled as a lock conflict. Errors thrown
        // by the protected operation must propagate, not masquerade as EEXIST.
        if (error.code !== 'EEXIST') throw error;
      }

      let owner = null;
      try {
        owner = JSON.parse(
          fs.readFileSync(path.join(this.lockPath, 'owner.json'), 'utf8')
        );
      } catch (ownerError) {
        if (ownerError.code !== 'ENOENT' && !(ownerError instanceof SyntaxError)) {
          throw ownerError;
        }
      }

      let stale = false;
      if (owner && owner.hostname === hostname && Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (processError) {
          stale = processError.code === 'ESRCH';
          if (processError.code !== 'ESRCH' && processError.code !== 'EPERM') {
            throw processError;
          }
        }
      }

      if (stale) {
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
            try { fs.renameSync(quarantinePath, this.lockPath); } catch {}
          }
          continue;
        } catch (reclaimError) {
          if (reclaimError.code !== 'ENOENT' && reclaimError.code !== 'EEXIST') {
            throw reclaimError;
          }
        }
      }

      if (Date.now() >= deadline) {
        const error = new Error('Execution storage lock acquisition timed out');
        error.code = 'EXECUTION_STORAGE_LOCK_TIMEOUT';
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
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
