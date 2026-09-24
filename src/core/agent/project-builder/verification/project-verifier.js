const VerificationResult =
  require('./verification-result');

class ProjectVerifier {
  constructor({ workspace }) {
    if (!workspace) {
      throw new TypeError(
        'workspace is required'
      );
    }

    this.workspace = workspace;
  }

  async verify({
    definitionOfDone,
    checks = []
  } = {}) {
    if (!definitionOfDone) {
      throw new TypeError(
        'definitionOfDone is required'
      );
    }

    const results = [];

    for (const check of checks) {
      if (
        !check ||
        typeof check.id !== 'string' ||
        typeof check.run !== 'function'
      ) {
        throw new TypeError(
          'Each verification check requires id and run'
        );
      }

      try {
        const result =
          await check.run({
            workspace: this.workspace
          });

        const passed =
          result === false
            ? false
            : result &&
              typeof result.passed === 'boolean'
              ? result.passed
              : true;

        results.push({
          id: check.id,
          passed,
          result
        });
      } catch (error) {
        results.push({
          id: check.id,
          passed: false,
          error: error.message
        });
      }
    }

    const passed =
      results.filter(
        check => check.passed
      ).length;

    const failed =
      results.length - passed;

    const definitionSatisfied =
      failed === 0 &&
      results.length > 0;

    return new VerificationResult({
      status:
        failed === 0
          ? 'passed'
          : 'failed',
      checks: results,
      passed,
      failed,
      definitionOfDoneSatisfied:
        definitionSatisfied
    }).toJSON();
  }
}

module.exports = ProjectVerifier;
