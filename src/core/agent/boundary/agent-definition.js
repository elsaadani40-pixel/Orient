const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

class AgentDefinition {
  constructor({
    id,
    name = id,
    version = 1,
    description = '',
    capabilities = [],
    allowedMemoryScopes = [],
    allowedAgentTargets = [],
    risk = 'low'
  } = {}) {
    if (!id || typeof id !== 'string') {
      throw new TypeError('Agent id is required');
    }
    if (!RISK_LEVELS.includes(risk)) {
      throw new Error('Invalid agent risk');
    }

    this.id = id;
    this.name = name;
    this.version = version;
    this.description = description;
    this.capabilities = Object.freeze([...new Set(capabilities.filter(Boolean))]);
    this.allowedMemoryScopes = Object.freeze([...new Set(allowedMemoryScopes.filter(Boolean))]);
    this.allowedAgentTargets = Object.freeze([...new Set(allowedAgentTargets.filter(Boolean))]);
    this.risk = risk;
  }

  canUseCapability(name) {
    return this.capabilities.includes('*') || this.capabilities.includes(name);
  }

  canReadMemory(scope) {
    return this.allowedMemoryScopes.includes('*') ||
      this.allowedMemoryScopes.includes(scope);
  }

  canCallAgent(agentId) {
    return this.allowedAgentTargets.includes('*') ||
      this.allowedAgentTargets.includes(agentId);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      capabilities: [...this.capabilities],
      allowedMemoryScopes: [...this.allowedMemoryScopes],
      allowedAgentTargets: [...this.allowedAgentTargets],
      risk: this.risk
    };
  }
}

module.exports = { AgentDefinition, RISK_LEVELS };
