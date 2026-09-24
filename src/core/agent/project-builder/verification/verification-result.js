class VerificationResult {
  constructor({
    status = 'unknown',
    checks = [],
    passed = 0,
    failed = 0,
    definitionOfDoneSatisfied = false
  } = {}) {
    this.status = status;
    this.checks = checks;
    this.passed = passed;
    this.failed = failed;
    this.definitionOfDoneSatisfied =
      definitionOfDoneSatisfied;
  }

  toJSON() {
    return {
      status: this.status,
      checks: this.checks,
      passed: this.passed,
      failed: this.failed,
      definitionOfDoneSatisfied:
        this.definitionOfDoneSatisfied
    };
  }
}

module.exports = VerificationResult;
