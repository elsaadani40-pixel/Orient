class BuildPolicyGate {
  constructor({ policy } = {}) {
    if (!policy) {
      throw new TypeError('policy is required');
    }

    this.policy = policy;
  }

  evaluate({ proposals = [] } = {}) {
    if (!Array.isArray(proposals)) {
      throw new TypeError('proposals must be an array');
    }

    const errors = [];

    if (!this.policy.allowWrite) {
      errors.push({
        code: 'WRITE_NOT_ALLOWED',
        message: 'Project modification is disabled by policy'
      });
    }

    for (const proposal of proposals) {
      if (!proposal || typeof proposal !== 'object') {
        errors.push({
          code: 'INVALID_PROPOSAL',
          message: 'Proposal must be an object'
        });
        continue;
      }

      if (
        proposal.action !== 'create' &&
        proposal.action !== 'update'
      ) {
        errors.push({
          code: 'INVALID_ACTION',
          path: proposal.path,
          message: 'Only create and update actions are allowed'
        });
      }

      if (
        typeof proposal.path !== 'string' ||
        !proposal.path
      ) {
        errors.push({
          code: 'INVALID_PATH',
          message: 'Proposal path is required'
        });
      }
    }

    return {
      allowed: errors.length === 0,
      errors
    };
  }
}

module.exports = BuildPolicyGate;
