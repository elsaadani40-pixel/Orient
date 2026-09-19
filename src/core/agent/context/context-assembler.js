class ContextAssembler {
  constructor(contextProvider) {
    if (!contextProvider) {
      throw new TypeError('contextProvider is required');
    }

    this.contextProvider = contextProvider;
  }

  async assemble(names = [], request = {}) {
    if (!Array.isArray(names)) {
      throw new TypeError('Context names must be an array');
    }

    const selected = [
      ...new Set(names.filter(Boolean))
    ];

    const context = {};

    for (const name of selected) {
      if (!this.contextProvider.has(name)) {
        continue;
      }

      context[name] =
        await this.contextProvider.get(
          name,
          request
        );
    }

    return {
      sources: selected,
      context
    };
  }
}

module.exports = ContextAssembler;
