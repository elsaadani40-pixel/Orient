'use strict';

const REQUIRED_METHODS = Object.freeze([
  'health',
  'listAgents',
  'listChannels',
  'listModels'
]);

class ExternalAgentProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.sealed = false;
  }

  register(provider) {
    if (this.sealed) {
      throw Object.assign(new Error('External agent provider registry is sealed'), {
        code: 'EXTERNAL_AGENT_PROVIDER_REGISTRY_SEALED'
      });
    }
    if (!provider || typeof provider !== 'object' ||
        typeof provider.id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(provider.id)) {
      throw new TypeError('External agent provider must have a valid stable id');
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof provider[method] !== 'function') {
        throw new TypeError(`External agent provider "${provider.id}" must implement ${method}()`);
      }
    }
    if (this.providers.has(provider.id)) {
      throw Object.assign(new Error('External agent provider is already registered'), {
        code: 'EXTERNAL_AGENT_PROVIDER_DUPLICATE'
      });
    }
    this.providers.set(provider.id, Object.freeze({
      id: provider.id,
      health: provider.health.bind(provider),
      listAgents: provider.listAgents.bind(provider),
      listChannels: provider.listChannels.bind(provider),
      listModels: provider.listModels.bind(provider)
    }));
    return this;
  }

  get(id) {
    return this.providers.get(id) || null;
  }

  list() {
    return [...this.providers.keys()];
  }

  seal() {
    this.sealed = true;
    return this;
  }
}

module.exports = ExternalAgentProviderRegistry;
