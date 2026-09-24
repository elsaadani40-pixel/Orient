class ProposalValidator {
  constructor({ workspace } = {}) {
    if (!workspace) {
      throw new TypeError('workspace is required');
    }

    this.workspace = workspace;
  }

  async validate({ proposals = [] } = {}) {
    if (!Array.isArray(proposals)) {
      throw new TypeError('proposals must be an array');
    }

    const paths = new Set();
    const errors = [];

    for (const [index, proposal] of proposals.entries()) {
      try {
        if (!proposal || typeof proposal !== 'object') {
          throw new TypeError('proposal must be an object');
        }

        const {
          action,
          path,
          content = ''
        } = proposal;

        if (action !== 'create' && action !== 'update') {
          throw new TypeError(
            'proposal action must be create or update'
          );
        }

        if (typeof path !== 'string' || !path) {
          throw new TypeError(
            'proposal path is required'
          );
        }

        if (typeof content !== 'string') {
          throw new TypeError(
            'proposal content must be a string'
          );
        }

        if (paths.has(path)) {
          throw new Error(
            `Duplicate proposal path: ${path}`
          );
        }

        paths.add(path);

        const exists =
          await this.workspace.exists(path);

        if (action === 'create' && exists) {
          throw new Error(
            `File already exists: ${path}`
          );
        }

        if (action === 'update' && !exists) {
          throw new Error(
            `File does not exist: ${path}`
          );
        }
      } catch (error) {
        errors.push({
          index,
          name: error.name,
          message: error.message
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = ProposalValidator;
