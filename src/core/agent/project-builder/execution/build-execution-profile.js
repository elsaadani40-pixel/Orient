class BuildExecutionProfile {
  constructor({
    name = 'engineering-builder',
    maxSteps = 20,
    timeoutMs = 120000,
    maxRetries = 2,
    allowRead = true,
    allowWrite = false,
    allowCommands = false,
    allowGit = false,
    allowedCommands = []
  } = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('name is required');
    }

    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new TypeError('maxSteps must be a positive integer');
    }

    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive integer');
    }

    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new TypeError(
        'maxRetries must be a non-negative integer'
      );
    }

    if (!Array.isArray(allowedCommands)) {
      throw new TypeError(
        'allowedCommands must be an array'
      );
    }

    this.name = name;
    this.maxSteps = maxSteps;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.allowRead = Boolean(allowRead);
    this.allowWrite = Boolean(allowWrite);
    this.allowCommands = Boolean(allowCommands);
    this.allowGit = Boolean(allowGit);
    this.allowedCommands = [...allowedCommands];
  }

  toJSON() {
    return {
      name: this.name,
      maxSteps: this.maxSteps,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      allowRead: this.allowRead,
      allowWrite: this.allowWrite,
      allowCommands: this.allowCommands,
      allowGit: this.allowGit,
      allowedCommands: [...this.allowedCommands]
    };
  }
}

module.exports = BuildExecutionProfile;
