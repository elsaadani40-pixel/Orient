const crypto = require('crypto');

class AgentEvent {
  constructor({
    type,
    executionId = null,
    goalId = null,
    data = {}
  } = {}) {
    if (!type) {
      throw new Error('Event type is required');
    }

    this.id = crypto.randomUUID();
    this.type = type;
    this.executionId = executionId;
    this.goalId = goalId;
    this.data = { ...data };
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return { ...this };
  }
}

module.exports = AgentEvent;
