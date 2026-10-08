const test = require('node:test');
const assert = require('node:assert/strict');

const AgentExecutionCoordinator = require('../../../../src/core/runtime/agent-execution-coordinator');

function createCoordinator() {
  let loopCalls = 0;
  const records = [];
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {},
    agentLoop: { run: async () => { loopCalls += 1; return { result: null, evaluation: { outcome: 'done' }, stepsExecuted: 0 }; } },
    checkpoint: async () => {},
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });
  return { coordinator, records, get loopCalls() { return loopCalls; } };
}

test('rejects an invalid plan before the execution loop can run', async () => {
  const harness = createCoordinator();
  const context = {
    requestId: 'req-1',
    input: 'test',
    metadata: {},
    record: (type, data) => harness.records.push({ type, data }),
    transitionAgentTo: () => {},
    getAgentLifecycle: () => 'planning',
    setPlan: () => {}
  };

  await assert.rejects(
    harness.coordinator.run({
      context,
      plan: { intent: 'test', steps: [] },
      validation: { valid: false, steps: [] }
    }),
    (error) => error.code === 'INVALID_PLAN_VALIDATION'
  );

  assert.equal(harness.loopCalls, 0);
  assert.equal(harness.records.at(-1).type, 'plan.validation.rejected');
});

test('rejects an invalid resumed plan before the execution loop can run', async () => {
  const harness = createCoordinator();
  const context = {
    requestId: 'req-2',
    input: 'test',
    metadata: {},
    record: (type, data) => harness.records.push({ type, data }),
    transitionAgentTo: () => {},
    getAgentLifecycle: () => 'executing',
    setPlan: () => {}
  };

  await assert.rejects(
    harness.coordinator.run({
      context,
      plan: { intent: 'test', steps: [] },
      validation: { valid: false, steps: [] },
      resumed: true
    }),
    (error) => error.code === 'INVALID_RESUME_PLAN'
  );

  assert.equal(harness.loopCalls, 0);
  assert.equal(harness.records.at(-1).data.resumed, true);
});
