class GoalToPlan {
  constructor(planningEngine) {
    if (!planningEngine) {
      throw new TypeError('planningEngine is required');
    }

    this.planningEngine = planningEngine;
  }

  create(goal) {
    if (!goal || !goal.id) {
      throw new Error('Valid goal is required');
    }

    return this.planningEngine.create({
      goalId: goal.id,
      steps: goal.steps || []
    });
  }
}

module.exports = GoalToPlan;
