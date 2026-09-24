const ImplementationPlan =
  require('./implementation-plan');

const ChangeSet =
  require('../modification/change-set');

class ImplementationPlanner {
  generate({
    buildPlan,
    changes = [],
    assumptions = [],
    risks = []
  } = {}) {
    if (
      !buildPlan ||
      typeof buildPlan !== 'object'
    ) {
      throw new TypeError(
        'buildPlan is required'
      );
    }

    if (!Array.isArray(changes)) {
      throw new TypeError(
        'changes must be an array'
      );
    }

    if (!Array.isArray(assumptions)) {
      throw new TypeError(
        'assumptions must be an array'
      );
    }

    if (!Array.isArray(risks)) {
      throw new TypeError(
        'risks must be an array'
      );
    }

    const changeSet =
      new ChangeSet({
        changes
      });

    return new ImplementationPlan({
      goal: buildPlan.goal ?? null,
      changeSet,
      assumptions,
      risks
    });
  }
}

module.exports = ImplementationPlanner;
