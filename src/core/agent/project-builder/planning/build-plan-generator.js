const BuildPlan = require('./build-plan');

class BuildPlanGenerator {
  generate({
    audit,
    goal = 'Complete the project according to its engineering requirements.'
  }) {
    if (!audit) {
      throw new TypeError('audit is required');
    }

    const phases = [
      {
        id: 'understand',
        order: 1,
        objective: 'Understand the project structure, architecture, and constraints.',
        status: 'pending'
      },
      {
        id: 'resolve-gaps',
        order: 2,
        objective: 'Resolve identified engineering gaps.',
        status: 'pending',
        gaps: audit.gaps || []
      },
      {
        id: 'implement',
        order: 3,
        objective: 'Implement the required changes within the approved workspace.',
        status: 'pending'
      },
      {
        id: 'verify',
        order: 4,
        objective: 'Run verification and validate the Definition of Done.',
        status: 'pending'
      }
    ];

    const constraints = [
      'Respect project engineering instructions.',
      'Do not modify files outside the allowed workspace.',
      'Do not execute unauthorized commands.',
      'Do not consider implementation complete without verification.',
      'Preserve existing architecture unless a justified change is required.'
    ];

    return new BuildPlan({
      goal,
      phases,
      constraints,
      definitionOfDone:
        audit.definitionOfDone || null
    }).toJSON();
  }
}

module.exports = BuildPlanGenerator;
