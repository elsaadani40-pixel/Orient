const test = require('node:test');
const assert = require('node:assert/strict');

const Replanner =
  require('../../../../src/core/planning/replanning/replanner');

const ReplanningDecision =
  require('../../../../src/core/planning/replanning/replanning-decision');

test('failed evaluation produces failed replanning decision', () => {
  const replanner = new Replanner({ maxReplans: 3 });

  const decision = replanner.decide({
    evaluation: { outcome: 'failed' },
    replans: 0,
    hasRemainingSteps: false
  });

  assert.equal(
    decision.outcome,
    ReplanningDecision.OUTCOMES.FAILED
  );

  assert.equal(
    decision.nextAction,
    ReplanningDecision.ACTIONS.STOP
  );
});

test('done evaluation produces done decision', () => {
  const replanner = new Replanner({ maxReplans: 3 });

  const decision = replanner.decide({
    evaluation: { outcome: 'done' },
    replans: 0,
    hasRemainingSteps: false
  });

  assert.equal(
    decision.outcome,
    ReplanningDecision.OUTCOMES.DONE
  );

  assert.equal(
    decision.nextAction,
    ReplanningDecision.ACTIONS.NONE
  );
});

test('replan is allowed before limit', () => {
  const replanner = new Replanner({ maxReplans: 3 });

  const decision = replanner.decide({
    evaluation: { outcome: 'replan' },
    replans: 1,
    hasRemainingSteps: false
  });

  assert.equal(
    decision.outcome,
    ReplanningDecision.OUTCOMES.REPLAN
  );

  assert.equal(
    decision.nextAction,
    ReplanningDecision.ACTIONS.REPLAN
  );
});

test('replan is rejected after limit', () => {
  const replanner = new Replanner({ maxReplans: 3 });

  const decision = replanner.decide({
    evaluation: { outcome: 'replan' },
    replans: 3,
    hasRemainingSteps: false
  });

  assert.equal(
    decision.outcome,
    ReplanningDecision.OUTCOMES.FAILED
  );

  assert.equal(
    decision.nextAction,
    ReplanningDecision.ACTIONS.STOP
  );
});

test('remaining steps produce next-step decision', () => {
  const replanner = new Replanner({ maxReplans: 3 });

  const decision = replanner.decide({
    evaluation: { outcome: 'next_step' },
    replans: 0,
    hasRemainingSteps: true
  });

  assert.equal(
    decision.outcome,
    ReplanningDecision.OUTCOMES.NEXT_STEP
  );

  assert.equal(
    decision.nextAction,
    ReplanningDecision.ACTIONS.CONTINUE
  );
});
