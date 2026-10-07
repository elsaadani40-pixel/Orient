class TenantQuotaPolicy {
  constructor({
    maxConcurrent = 1,
    maxQueued = 1000,
    maxInputChars = 100000,
    maxToolInputChars = 50000,
    maxRetries = 2
  } = {}) {
    const values = {
      maxConcurrent,
      maxQueued,
      maxInputChars,
      maxToolInputChars,
      maxRetries
    };

    for (const [name, value] of Object.entries(values)) {
      if (!Number.isInteger(value) || value < 0 || (name !== 'maxRetries' && value < 1)) {
        throw Object.assign(
          new Error(`${name} must be a valid non-negative integer`),
          { code: 'TENANT_QUOTA_INVALID' }
        );
      }
    }

    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.maxInputChars = maxInputChars;
    this.maxToolInputChars = maxToolInputChars;
    this.maxRetries = maxRetries;
    Object.freeze(this);
  }

  toJSON() {
    return {
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      maxInputChars: this.maxInputChars,
      maxToolInputChars: this.maxToolInputChars,
      maxRetries: this.maxRetries
    };
  }
}

module.exports = TenantQuotaPolicy;
