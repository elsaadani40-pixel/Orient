class AgentRegistry {
  constructor() {
    this.agents = new Map();
  }

  register(agent) {
    if (!agent || !agent.id) {
      throw new TypeError('Agent definition is required');
    }
    if (this.agents.has(agent.id)) {
      throw new Error('Agent already registered');
    }
    this.agents.set(agent.id, agent);
    return agent;
  }

  get(id) {
    return this.agents.get(id) || null;
  }

  require(id) {
    const agent = this.get(id);
    if (!agent) {
      throw Object.assign(
        new Error('Agent is not registered'),
        { code: 'AGENT_NOT_REGISTERED' }
      );
    }
    return agent;
  }

  canInvoke(sourceAgentId, targetAgentId) {
    const source = this.require(sourceAgentId);
    this.require(targetAgentId);
    return source.canCallAgent(targetAgentId);
  }

  list() {
    return [...this.agents.values()].map(agent =>
      typeof agent.toJSON === 'function' ? agent.toJSON() : agent
    );
  }
}

module.exports = AgentRegistry;
