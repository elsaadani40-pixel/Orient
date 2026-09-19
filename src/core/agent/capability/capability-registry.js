class CapabilityRegistry {
  constructor() {
    this.capabilities = new Map();
  }

  register(capability) {
    if (!capability || !capability.name) {
      throw new TypeError('Invalid capability');
    }

    if (this.capabilities.has(capability.name)) {
      throw new Error('Capability already registered');
    }

    this.capabilities.set(
      capability.name,
      capability
    );

    return capability;
  }

  get(name) {
    return this.capabilities.get(name) || null;
  }

  has(name) {
    return this.capabilities.has(name);
  }

  list() {
    return Array.from(
      this.capabilities.values()
    ).map((capability) =>
      typeof capability.toJSON === 'function'
        ? capability.toJSON()
        : capability
    );
  }
}

module.exports = CapabilityRegistry;
