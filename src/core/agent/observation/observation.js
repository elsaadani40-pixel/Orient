const crypto = require('crypto');

class Observation {
  constructor({
    executionId,
    nodeId = null,
    tool = null,
    outcome,
    result = null,
    error = null,
    duration = 0
  } = {}) {
    if (!executionId) {
      throw new Error('executionId is required');
    }

    if (!outcome) {
      throw new Error('outcome is required');
    }

    this.id = crypto.randomUUID();
    this.executionId = executionId;
    this.nodeId = nodeId;
    this.tool = tool;
    this.outcome = outcome;
    this.result = result;
    this.error = error;
    this.duration = duration;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return { ...this };
  }
}

module.exports = Observation;
