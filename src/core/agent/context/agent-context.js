class AgentContext {
  constructor({
    agentId = 'default-agent',
    goal = null,
    input = ''
  } = {}) {
    this.agentId = agentId;
    this.goal = goal;
    this.input = String(input || '');
    this.data = {};
  }

  set(key, value) {
    this.data[key] = value;
    return this;
  }

  get(key) {
    return this.data[key];
  }

  toJSON() {
    return {
      agentId: this.agentId,
      goal: this.goal,
      input: this.input,
      data: { ...this.data }
    };
  }
}

module.exports = AgentContext;
