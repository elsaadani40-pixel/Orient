class ContextSelector {
  constructor(contextProvider) {
    if (!contextProvider) {
      throw new TypeError('contextProvider is required');
    }

    this.contextProvider = contextProvider;
  }

  select(names = []) {
    return names.filter((name) =>
      this.contextProvider.has(name)
    );
  }
}

module.exports = ContextSelector;
