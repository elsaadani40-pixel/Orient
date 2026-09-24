class BuildPlan {
  constructor({
    goal,
    phases = [],
    constraints = [],
    definitionOfDone = null
  } = {}) {
    if (!goal || typeof goal !== 'string') {
      throw new TypeError('goal is required');
    }

    this.goal = goal;
    this.phases = phases;
    this.constraints = constraints;
    this.definitionOfDone = definitionOfDone;
  }

  toJSON() {
    return {
      goal: this.goal,
      phases: this.phases,
      constraints: this.constraints,
      definitionOfDone: this.definitionOfDone
    };
  }
}

module.exports = BuildPlan;
