const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowWorker = require('../../../../src/core/workflow/async-workflow-worker');

test('AsyncWorkflowWorker renews the durable lease while a step runs', async () => {
  const renewals = [];
  let released = false;
  let stepCompleted = false;

  const step = { id: 'step-1' };
  const instance = {
    workflowId: 'heartbeat-workflow',
    state: 'RUNNING',
    cancelRequested: false,
    cancelled: false,
    deadlineAt: null,
    definition: { steps: [step] },
    steps: { 'step-1': { state: 'READY' } },
    readySteps() {
      return stepCompleted ? [] : [step];
    },
    markStepRunning(stepId) {
      this.steps[stepId].state = 'RUNNING';
    },
    markStepCompleted(stepId, result) {
      this.steps[stepId].state = 'COMPLETED';
      this.steps[stepId].result = result;
      stepCompleted = true;
    },
    markStepFailed() {
      throw new Error('unexpected step failure');
    },
    transition(state) {
      this.state = state;
    },
    transitionAgentTo() {},
  };

  const lease = {
    workflowId: instance.workflowId,
    leaseId: 'lease-heartbeat',
    workerId: 'worker-heartbeat',
    expiresAt: Date.now() + 3000,
    cancelled: false,
    deadlineAt: null,
    instance
  };

  const scheduler = {
    leaseDurationMs: 3000,
    async leaseAsync() {
      return renewals.length === 0 ? lease : null;
    },
    async renewAsync(workflowId, leaseId) {
      renewals.push({ workflowId, leaseId });
      return lease;
    },
    async persistAsync() {},
    async releaseAsync(workflowId, leaseId) {
      released = workflowId === instance.workflowId && leaseId === lease.leaseId;
      return true;
    },
    async retryAsync() {
      throw new Error('unexpected retry');
    }
  };

  const worker = new AsyncWorkflowWorker({
    scheduler,
    executor: async () => {
      await new Promise(resolve => setTimeout(resolve, 2200));
      return { ok: true };
    },
    workerId: 'worker-heartbeat'
  });

  const result = await worker.tick();

  assert.equal(result.state, 'COMPLETED');
  assert.equal(released, true);
  assert.ok(renewals.length >= 2, 'expected initial renewal plus at least one heartbeat renewal');
  assert.ok(renewals.every(call => call.workflowId === instance.workflowId));
  assert.ok(renewals.every(call => call.leaseId === lease.leaseId));
});
