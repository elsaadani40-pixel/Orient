const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ExecutionRepository {
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
      updatedAt: execution.updatedAt || now
    };
  }

  write(executions) {
    const temporaryFile = `${this.filePath}.tmp`;

    try {
      fs.writeFileSync(
        temporaryFile,
        JSON.stringify(executions, null, 2) + '\n',
        'utf8'
      );

      fs.renameSync(temporaryFile, this.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(temporaryFile)) {
          fs.unlinkSync(temporaryFile);
        }
      } catch {}

      throw new Error(`Execution storage write failed: ${error.message}`);
    }
  }

  findAll() {
    return this.readRaw().map(execution =>
      this.normalize(execution)
    );
  }

  findById(executionId) {
    return (
      this.findAll().find(
        execution =>
          execution.executionId === executionId ||
          execution.id === executionId
      ) || null
    );
  }

  findByGoalId(goalId) {
    if (!goalId) {
      return [];
    }

    return this.findAll().filter(
      execution => execution.goalId === goalId
    );
  }

  insert(execution) {
    const normalized = this.normalize(execution);
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
  }

  update(executionId, patch) {
    if (!executionId) {
      throw new TypeError('executionId is required');
    }

    if (!patch || typeof patch !== 'object') {
      throw new TypeError('patch must be an object');
    }

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

    const updated = this.normalize({
      ...current,
      ...patch,
      id: current.id,
      executionId: current.executionId,
      updatedAt: new Date().toISOString()
    });

    executions[index] = updated;
    this.write(executions);

    return updated;
  }

  deleteById(executionId) {
    const executions = this.readRaw();

    const index = executions.findIndex(
      execution =>
        execution.executionId === executionId ||
        execution.id === executionId
    );

    if (index === -1) {
      return false;
    }

    executions.splice(index, 1);
    this.write(executions);

    return true;
  }

  count() {
    return this.readRaw().length;
  }
}

module.exports = ExecutionRepository;
