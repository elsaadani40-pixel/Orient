const crypto = require('crypto');

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

        if (action === 'update' && typeof proposal.expectedContentSha256 === 'string') {
          const current = await this.workspace.readText(path);
          const actualContentSha256 = crypto
            .createHash('sha256')
            .update(current)
            .digest('hex');

          if (actualContentSha256 !== proposal.expectedContentSha256) {
            const error = new Error(
              `Change precondition failed: ${path} was modified after the proposal was created`
            );
            error.code = 'CHANGE_PRECONDITION_FAILED';
            error.expectedContentSha256 = proposal.expectedContentSha256;
            error.actualContentSha256 = actualContentSha256;
            throw error;
          }
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
