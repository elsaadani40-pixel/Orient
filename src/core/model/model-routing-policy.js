class ModelRoutingPolicy {
  constructor({
    agentRegistry,
    allowRemote = false
  } = {}) {
    if (!agentRegistry) {
      throw new TypeError('agentRegistry is required');
    }

    this.agentRegistry = agentRegistry;
    this.allowRemote = allowRemote;
  }

  authorize(provider, request = {}) {
    if (!provider) {
      return false;
    }

    if (!this.allowRemote && provider.locality !== 'local') {
      return false;
    }

    if (request.agentId) {
      const agent = this.agentRegistry.require(request.agentId);
      const required = Array.isArray(request.requiredCapabilities)
        ? request.requiredCapabilities
        : [];

      if (!required.every(capability =>
        agent.canUseCapability(`model:${capability}`)
      )) {
        return false;
      }
    }

    return true;
  }

  asFunction() {
    return (provider, request) =>
      this.authorize(provider, request);
  }
}

module.exports = ModelRoutingPolicy;
