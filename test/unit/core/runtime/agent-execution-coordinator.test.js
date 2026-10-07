const test = require('node:test');
const assert = require('node:assert/strict');

const AgentExecutionCoordinator = require('../../../../src/core/runtime/agent-execution-coordinator');

function contextStub() {
  return {
    requestId: 'req-1',
    input: 'hello',
    metadata: {},
    observations: [],
    record() {},
    transitionAgentTo() {},
    setPlan() {},
  };
}

test('runs agent execution and returns terminal execution state', async () => {
  const context = contextStub();
  const plan = { intent: 'test', steps: [{ step: 'one', tool: 'noop' }] };
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        return { nextAction: 'complete', toJSON: () => ({ nextAction: 'complete' }) };
      }
    },
    agentLoop: {
      async run() {
        return { stepsExecuted: 1, evaluation: { success: true }, result: { ok: true } };
      }
    },
    checkpoint: async () => {},
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });

  const result = await coordinator.run({
    context,
    plan,
    validation: { valid: true, steps: plan.steps },
    previousFingerprint: 'initial',
    tenantId: 'tenant-1'
  });

  assert.equal(result.plan, plan);
  assert.equal(result.planRevision, 1);
  assert.equal(result.replans, 0);
  assert.deepEqual(result.loopResult.result, { ok: true });
  assert.equal(result.replanningDecision.nextAction, 'complete');
});

test('replans only after a changed validated plan', async () => {
  const context = contextStub();
  const firstPlan = { intent: 'first', steps: [{ step: 'one' }] };
  const nextPlan = { intent: 'second', steps: [{ step: 'two' }] };
  let runs = 0;
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        runs += 1;
        return {
          nextAction: runs === 1 ? 'replan' : 'complete',
          toJSON: () => ({ nextAction: runs === 1 ? 'replan' : 'complete' })
        };
      },
      async replan() {
        return { plan: nextPlan, validation: { valid: true, steps: nextPlan.steps } };
      }
    },
    agentLoop: {
      async run() {
        return { stepsExecuted: 1, evaluation: {}, result: { runs } };
      }
    },
    checkpoint: async () => {},
    validateReplannedPlan: (candidate, previous) => ({
      valid: candidate !== firstPlan && candidate !== previous,
      fingerprint: 'next'
    })
  });

  const result = await coordinator.run({
    context,
    plan: firstPlan,
    validation: { valid: true, steps: firstPlan.steps },
    previousFingerprint: 'initial',
    tenantId: 'tenant-1'
  });

  assert.equal(result.plan, nextPlan);
  assert.equal(result.planRevision, 2);
  assert.equal(result.replans, 1);
  assert.equal(runs, 2);
});
