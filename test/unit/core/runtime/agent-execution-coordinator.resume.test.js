const test = require('node:test');
const assert = require('node:assert/strict');

const AgentExecutionCoordinator = require('../../../../src/core/runtime/agent-execution-coordinator');

test('does not repeat the executing lifecycle transition during resume', async () => {
  const transitions = [];
  const context = {
    requestId: 'resume-1',
    input: 'resume',
    metadata: {},
    observations: [],
    getAgentLifecycle: () => 'executing',
    record() {},
    transitionAgentTo(state) { transitions.push(state); },
    setPlan() {}
  };

  const plan = { intent: 'resume', steps: [{ step: 'one' }] };
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        return { nextAction: 'complete', toJSON: () => ({ nextAction: 'complete' }) };
      }
    },
    agentLoop: {
      async run() {
        return { stepsExecuted: 1, evaluation: {}, result: { resumed: true } };
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
    tenantId: 'tenant-1',
    resumed: true
  });

  assert.equal(result.loopResult.result.resumed, true);
  assert.ok(!transitions.includes('executing'));
  assert.deepEqual(transitions, ['observing', 'evaluating']);
});


test('renews a durable resume lease before persisting each resume checkpoint', async () => {
  const order = [];
  const context = {
    requestId: 'resume-renew-1',
    input: 'resume',
    metadata: {},
    observations: [],
    getAgentLifecycle: () => 'executing',
    record() {},
    transitionAgentTo() {},
    setPlan() {}
  };
  const plan = { intent: 'resume', steps: [{ step: 'one' }] };
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        return { nextAction: 'complete', toJSON: () => ({ nextAction: 'complete' }) };
      }
    },
    agentLoop: {
      async run({ runtimeContext }) {
        await runtimeContext.onCheckpoint({ step: 1, planRevision: 1 });
        return { stepsExecuted: 1, evaluation: {}, result: { resumed: true } };
      }
    },
    checkpoint: async () => { order.push('checkpoint'); },
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });

  await coordinator.run({
    context,
    plan,
    validation: { valid: true, steps: plan.steps },
    previousFingerprint: 'initial',
    tenantId: 'tenant-1',
    resumed: true,
    renewResumeLease: async () => { order.push('renew'); }
  });

  assert.deepEqual(order, ['renew', 'checkpoint']);
});
