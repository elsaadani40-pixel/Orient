const test = require('node:test');
const assert = require('node:assert/strict');
const WorkflowWorker = require('../../../../src/core/workflow/workflow-worker');

test('WorkflowWorker refuses to commit a step after fencing is lost during execution', async () => {
  let assertCalls = 0;
  let completed = false;
  let released = false;
  const step = { id: 'step-1', dependsOn: [] };
  const instance = {
    workflowId: 'sync-fencing-loss',
    state: 'RUNNING',
    cancelRequested: false,
    definition: {
      steps: [step]
    },
    metadata: {},
    steps: {
      'step-1': { state: 'PENDING', attempts: 0 }
    },
    readySteps() { return completed ? [] : [step]; },
    markStepRunning(id) { this.steps[id].state = 'RUNNING'; this.steps[id].attempts += 1; },
    markStepCompleted() { completed = true; this.steps['step-1'].state = 'COMPLETED'; },
    markStepFailed(id, error) { this.steps[id].state = 'FAILED'; this.steps[id].error = { code: error.code }; },
    transition(state) { this.state = state; }
  };
  const lease = {
    workflowId: instance.workflowId,
    leaseId: 'sync-lease',
    fencingToken: 11,
    cancelled: false,
    instance
  };
  const scheduler = {
    lease() { return lease; },
    renew() { return lease; },
    assertCurrent() {
      assertCalls += 1;
      if (assertCalls >= 2) throw Object.assign(new Error('stale fencing token'), { code: 'WORKFLOW_FENCING_REJECTED' });
      return true;
    },
    release() { released = true; },
    retry() { return false; }
  };

  const worker = new WorkflowWorker({
    scheduler,
    workerId: 'sync-worker',
    executor: async () => ({ externalSideEffect: true })
  });

  const result = await worker.tick();
  assert.equal(result.state, 'FAILED');
  assert.equal(completed, false);
  assert.equal(result.steps['step-1'].state, 'FAILED');
  assert.equal(assertCalls, 2);
  assert.equal(released, true);
});
