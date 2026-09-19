const crypto = require('crypto');

class ExecutionContext {
  constructor({ requestId, input }) {
    this.executionId = crypto.randomUUID();
    this.requestId = requestId;
    this.input = input;

    this.status = 'created';
    this.startedAt = null;
    this.completedAt = null;

    this.plan = null;
    this.tool = null;
    this.result = null;

    this.events = [];
  }

  start() {
    this.status = 'running';
    this.startedAt = new Date().toISOString();

    this.record('execution.started');

    return this;
  }

  setPlan(plan) {
    this.plan = plan;

    this.record('plan.created', {
      intent: plan.intent,
      tool: plan.tool,
      confidence: plan.confidence
    });

    return this;
  }

  setTool(toolName) {
    this.tool = toolName;

    this.record('tool.selected', {
      tool: toolName
    });

    return this;
  }

  setResult(result) {
    this.result = result;

    return this;
  }

  complete() {
    this.status = 'completed';
    this.completedAt = new Date().toISOString();

    this.record('execution.completed');

    return this;
  }

  fail(error) {
    this.status = 'failed';
    this.completedAt = new Date().toISOString();

    this.record('execution.failed', {
      code: error.code || 'EXECUTION_FAILED',
      message: error.message
    });

    return this;
  }

  record(type, data = {}) {
    this.events.push({
      id: crypto.randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      data
    });

    return this;
  }

  snapshot() {
    return {
      executionId: this.executionId,
      requestId: this.requestId,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      plan: this.plan,
      tool: this.tool,
      events: this.events
    };
  }
}

module.exports = ExecutionContext;
