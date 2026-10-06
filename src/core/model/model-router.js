class ModelRouter {
  constructor({ providers = [], policy = null } = {}) {
    this.providers = new Map();
    this.policy = policy || (() => true);

    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider) {
    if (!provider || !provider.id || typeof provider.complete !== 'function') {
      throw new TypeError('Invalid model provider');
    }
    if (this.providers.has(provider.id)) {
      throw new Error('Model provider already registered');
    }
    this.providers.set(provider.id, provider);
    return provider;
  }

  list() {
    return [...this.providers.values()].map(provider => ({
      id: provider.id,
      capabilities: [...new Set(provider.capabilities || [])],
      costClass: provider.costClass || 'unknown',
      locality: provider.locality || 'remote'
    }));
  }

  route(request = {}) {
    const candidates = [...this.providers.values()].filter(provider =>
      this.policy(provider, request) !== false
    );

    if (!candidates.length) {
      throw Object.assign(
        new Error('No model provider satisfies the routing policy'),
        { code: 'MODEL_ROUTE_UNAVAILABLE' }
      );
    }

    const selected = candidates
      .filter(provider => this.supports(provider, request))
      .sort((a, b) => this.score(b, request) - this.score(a, request))[0];

    if (!selected) {
      throw Object.assign(
        new Error('No model provider supports the requested capability'),
        { code: 'MODEL_CAPABILITY_UNAVAILABLE' }
      );
    }

    return {
      providerId: selected.id,
      reason: this.routeReason(selected, request)
    };
  }

  async complete(request = {}) {
    const route = this.route(request);
    const provider = this.providers.get(route.providerId);
    const result = await provider.complete(request);
    return {
      ...result,
      routing: route
    };
  }

  supports(provider, request) {
    const required = Array.isArray(request.requiredCapabilities)
      ? request.requiredCapabilities
      : [];
    const capabilities = new Set(provider.capabilities || []);
    return required.every(capability => capabilities.has(capability));
  }

  score(provider, request) {
    const preferredLocality = request.preferredLocality;
    const preferredCostClass = request.preferredCostClass;
    const localityScore = preferredLocality && provider.locality === preferredLocality ? 100 : 0;
    const costScore = preferredCostClass && provider.costClass === preferredCostClass ? 50 : 0;
    const capabilityScore = (provider.capabilities || []).length;
    return localityScore + costScore + capabilityScore;
  }

  routeReason(provider, request) {
    return {
      providerId: provider.id,
      locality: provider.locality || 'remote',
      costClass: provider.costClass || 'unknown',
      requiredCapabilities: [...(request.requiredCapabilities || [])],
      preferredLocality: request.preferredLocality || null,
      preferredCostClass: request.preferredCostClass || null
    };
  }
}

module.exports = ModelRouter;
