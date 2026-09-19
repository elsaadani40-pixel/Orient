class CapabilityMapper {
  constructor({ mappings = {} } = {}) {
    this.mappings = new Map(
      Object.entries(mappings)
    );
  }

  register(tool, capability) {
    if (!tool || typeof tool !== 'string') {
      throw new TypeError('Tool name is required');
    }

    if (!capability || typeof capability !== 'string') {
      throw new TypeError('Capability name is required');
    }

    if (this.mappings.has(tool)) {
      throw new Error(
        `Capability mapping already exists for "${tool}"`
      );
    }

    this.mappings.set(tool, capability);

    return this;
  }

  get(tool) {
    return this.mappings.get(tool) || null;
  }

  has(tool) {
    return this.mappings.has(tool);
  }

  list() {
    return Array.from(
      this.mappings.entries()
    ).map(([tool, capability]) => ({
      tool,
      capability
    }));
  }
}

module.exports = CapabilityMapper;
