class ContextBudget {
  constructor({ maxSources = 5 } = {}) {
    if (!Number.isInteger(maxSources) || maxSources < 1) {
      throw new Error('Invalid context budget');
    }

    this.maxSources = maxSources;
  }

  limit(sources = []) {
    if (!Array.isArray(sources)) {
      throw new TypeError('Sources must be an array');
    }

    return sources.slice(0, this.maxSources);
  }
}

module.exports = ContextBudget;
