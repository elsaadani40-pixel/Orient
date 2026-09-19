const test = require('node:test');
const assert = require('node:assert/strict');

const AgentOrchestrator =
  require('../../../../../src/core/agent/orchestrator/agent-orchestrator');

const DecisionEngine =
  require('../../../../../src/core/agent/decision/decision-engine');

const RecoveryEngine =
  require('../../../../../src/core/agent/recovery/recovery-engine');

const Replanner =
  require('../../../../../src/core/planning/replanning/replanner');

const PlanValidator =
  require('../../../../../src/core/planning/validation/plan-validator');

test('constructor requires orchestration dependencies', () => {
  assert.throws(
    () => new AgentOrchestrator(),
    /planner is required/
  );
});

test('plan validates and returns canonical plan', async () => {
  const planner = {
    async plan() {
      return {
        intent: 'memory.search',
        input: 'احمد',
        confidence: 0.98,
        steps: [
          {
            step: 1,
            tool: 'memory.search',
            input: 'احمد'
          }
        ]
      };
    }
  };

  const orchestrator = new AgentOrchestrator({
    planner,
    planValidator: new PlanValidator({ maxSteps: 5 }),
    replanner: new Replanner({ maxReplans: 3 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });

  const result =
    await orchestrator.plan('ماذا تعرف عن احمد');

  assert.equal(result.validation.valid, true);
  assert.equal(result.plan.intent, 'memory.search');
  assert.equal(result.plan.steps.length, 1);
});

test('decision delegates to DecisionEngine', () => {
  const orchestrator = new AgentOrchestrator({
    planner: { async plan() {} },
    planValidator: new PlanValidator({ maxSteps: 5 }),
    replanner: new Replanner({ maxReplans: 3 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });

  const result =
    orchestrator.decide({
      outcome: 'done',
      reason: 'completed'
    });

  assert.equal(result.action, 'complete');
});

test('replanning decision delegates to Replanner', () => {
  const orchestrator = new AgentOrchestrator({
    planner: { async plan() {} },
    planValidator: new PlanValidator({ maxSteps: 5 }),
    replanner: new Replanner({ maxReplans: 3 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });

  const result =
    orchestrator.decideReplanning({
      evaluation: {
        outcome: 'replan',
        reason: 'needs replanning'
      },
      replans: 0,
      hasRemainingSteps: false
    });

  assert.equal(result.outcome, 'replan');
  assert.equal(result.nextAction, 'replan');
});

test('recovery delegates to RecoveryEngine', async () => {
  const orchestrator = new AgentOrchestrator({
    planner: { async plan() {} },
    planValidator: new PlanValidator({ maxSteps: 5 }),
    replanner: new Replanner({ maxReplans: 3 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });

  const result =
    await orchestrator.recover({
      code: 'TIMEOUT'
    });

  assert.equal(result.action, 'retry');
  assert.equal(result.metadata.retryable, true);
});
