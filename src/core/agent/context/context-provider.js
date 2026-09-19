class ContextProvider {
  constructor() {
    this.providers = new Map();
  }

  register(name, provider) {
    if (!name || typeof provider !== 'function') {
      throw new TypeError('Invalid context provider');
    }

    if (this.providers.has(name)) {
      throw new Error('Context provider already registered');
    }

    this.providers.set(name, provider);

    return this;
  }

  async get(name, request = {}) {
    const provider = this.providers.get(name);

    if (!provider) {
      throw new Error(`Context provider "${name}" not found`);
    }

    return provider(request);
  }

  has(name) {
    return this.providers.has(name);
  }

  list() {
    return Array.from(this.providers.keys());
  }
}

module.exports = ContextProvider;
