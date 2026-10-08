class BuildExecutionResult {
  constructor({
    status = 'planned',
    plan = null,
    changeSet = null,
    modification = null,
    verification = null,
    rollback = null,
    error = null
  } = {}) {
    const allowedStatuses = [
      'planned',
      'modified',
      'verified',
      'failed',
      'failed-and-rolled-back',
      'rollback-failed'
    ];

    if (!allowedStatuses.includes(status)) {
      throw new TypeError(
        `Invalid execution status: ${status}`
      );
    }

    this.status = status;
    this.plan = plan;
    this.changeSet = changeSet;
    this.modification = modification;
    this.verification = verification;
    this.rollback = rollback;
    this.error = error;
  }

  toJSON() {
    return {
      status: this.status,
      plan: this.plan,
      changeSet: this.changeSet,
      modification: this.modification,
      verification: this.verification,
      rollback: this.rollback,
      error: this.error
    };
  }
}

module.exports = BuildExecutionResult;
