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

    let modification;
    let snapshots = [];

    try {
      snapshots = [];
      for (const change of changeSet.changes) {
        snapshots.push(await this.modifier.snapshot(change));
      }

      modification =
        await this.modifier.apply(changeSet);

      const verification =
        await this.verifier.verify({
          definitionOfDone,
          checks
        });

      if (!verification.passed) {
        let rollback = { rolledBack: false };
        try {
          rollback = await this.modifier.rollback(snapshots);
        } catch (rollbackError) {
          return new BuildExecutionResult({
            status: 'rollback-failed',
            plan,
            changeSet,
            modification,
            verification,
            error: {
              name: rollbackError.name,
              message: rollbackError.message
            },
            rollback
          });
        }

        return new BuildExecutionResult({
          status: 'failed-and-rolled-back',
          plan,
          changeSet,
          modification,
          verification,
          rollback
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
