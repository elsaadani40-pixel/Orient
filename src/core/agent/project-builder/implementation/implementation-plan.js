class ImplementationPlan {
  constructor({
    goal = null,
    changeSet = null,
    assumptions = [],
    risks = []
  } = {}) {
    if (
      goal !== null &&
      typeof goal !== 'string'
    ) {
      throw new TypeError(
        'goal must be a string or null'
      );
    }

    if (
      changeSet !== null &&
      (
        !changeSet ||
        !Array.isArray(changeSet.changes)
      )
    ) {
      throw new TypeError(
        'changeSet must be a ChangeSet or null'
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

    this.goal = goal;
    this.changeSet = changeSet;
    this.assumptions = assumptions;
    this.risks = risks;
  }

  toJSON() {
    return {
      goal: this.goal,
      changeSet:
        this.changeSet?.toJSON?.() ??
        this.changeSet,
      assumptions: [...this.assumptions],
      risks: [...this.risks]
    };
  }
}

module.exports = ImplementationPlan;
