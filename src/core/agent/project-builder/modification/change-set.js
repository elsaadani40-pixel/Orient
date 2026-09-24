class ChangeSet {
  constructor({ changes = [] } = {}) {
    if (!Array.isArray(changes)) {
      throw new TypeError(
        'changes must be an array'
      );
    }

    this.changes = [];

    for (const change of changes) {
      this.add(change);
    }
  }

  validateChange(change) {
    if (!change || typeof change !== 'object') {
      throw new TypeError(
        'Each change must be an object'
      );
    }

    const {
      action,
      path,
      content = ''
    } = change;

    if (
      action !== 'create' &&
      action !== 'update'
    ) {
      throw new TypeError(
        'Change action must be create or update'
      );
    }

    if (
      typeof path !== 'string' ||
      !path
    ) {
      throw new TypeError(
        'Change path is required'
      );
    }

    if (typeof content !== 'string') {
      throw new TypeError(
        'Change content must be a string'
      );
    }

    if (
      this.changes.some(
        existing => existing.path === path
      )
    ) {
      throw new Error(
        `Duplicate change path: ${path}`
      );
    }

    return {
      action,
      path,
      content
    };
  }

  add(change) {
    this.changes.push(
      this.validateChange(change)
    );

    return this;
  }

  toJSON() {
    return {
      changes: [...this.changes]
    };
  }
}

module.exports = ChangeSet;
