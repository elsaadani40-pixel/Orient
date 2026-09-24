const BuildExecutionResult =
  require('./build-execution-result');

class BuildExecutionService {
  constructor({
    modifier,
    verifier
  } = {}) {
    if (!modifier) {
      throw new TypeError('modifier is required');
    }

    if (!verifier) {
      throw new TypeError('verifier is required');
    }

    this.modifier = modifier;
    this.verifier = verifier;
  }

  async execute({
    plan = null,
    changeSet,
    definitionOfDone,
    checks = []
  } = {}) {
    if (
      !changeSet ||
      !Array.isArray(changeSet.changes)
    ) {
      throw new TypeError(
        'changeSet with changes is required'
      );
    }

    try {
      const modification =
        await this.modifier.apply(changeSet);


      const verification =
        await this.verifier.verify({
          definitionOfDone,
          checks
        });

      if (!verification.passed) {
        return new BuildExecutionResult({
          status: 'failed',
          plan,
          changeSet,
          modification,
          verification
        });
      }

      return new BuildExecutionResult({
        status: 'verified',
        plan,
        changeSet,
        modification,
        verification
      });
    } catch (error) {
      return new BuildExecutionResult({
        status: 'failed',
        plan,
        changeSet,
        error: {
          name: error.name,
          message: error.message
        }
      });
    }
  }
}

module.exports = BuildExecutionService;
