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


test('AsyncWorkflowWorker refreshes worker registry liveness during a long step', async () => {
  const registrations = [];
  const heartbeats = [];
  let released = false;
  let stepCompleted = false;
  const step = { id: 'step-1' };
  const instance = {
    workflowId: 'worker-heartbeat-liveness',
    state: 'RUNNING',
    cancelRequested: false,
    deadlineAt: null,
    definition: { steps: [step] },
    steps: { 'step-1': { state: 'READY' } },
    readySteps() { return stepCompleted ? [] : [step]; },
    markStepRunning(id) { this.steps[id].state = 'RUNNING'; },
    markStepCompleted(id, result) { this.steps[id].state = 'COMPLETED'; this.steps[id].result = result; stepCompleted = true; },
    markStepFailed() { throw new Error('unexpected step failure'); },
    transition(state) { this.state = state; },
    transitionAgentTo() {}
  };
  const lease = { workflowId: instance.workflowId, leaseId: 'lease-1', workerId: 'worker-1', fencingToken: 1, expiresAt: Date.now() + 3000, cancelled: false, deadlineAt: null, instance };
  const scheduler = {
    leaseDurationMs: 3000,
    async leaseAsync() { return lease; },
    async renewAsync() { return lease; },
    async assertCurrentAsync() { return true; },
    async persistAsync() {},
    async releaseAsync() { released = true; return true; },
    async retryAsync() { throw new Error('unexpected retry'); }
  };
  const registry = {
    async register(worker) { registrations.push(worker); return worker; },
    async heartbeat(workerId, payload) { heartbeats.push({ workerId, ...payload }); return registrations[0]; }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler,
    workerRegistry: registry,
    workerId: 'worker-1',
    tenantId: 'tenant-1',
    workerLeaseMs: 3000,
    executor: async () => {
      await new Promise(resolve => setTimeout(resolve, 2200));
      return { ok: true };
    }
  });
  const result = await worker.tick();
  assert.equal(result.state, 'COMPLETED');
  assert.equal(released, true);
  assert.equal(registrations.length, 1);
  assert.ok(heartbeats.length >= 1, 'expected worker registry heartbeat while step was running');
  assert.ok(heartbeats.every(call => call.workerId === 'worker-1'));
  assert.ok(heartbeats.every(call => call.tenantId === 'tenant-1'));
});

test('AsyncWorkflowWorker stops safely when worker heartbeat fails', async () => {
  let released = false;
  let executions = 0;
  const step = { id: 'step-1' };
  const instance = {
    workflowId: 'worker-heartbeat-failure',
    state: 'RUNNING',
    cancelRequested: false,
    deadlineAt: null,
    definition: { steps: [step] },
    steps: { 'step-1': { state: 'READY' } },
    readySteps() { return executions > 0 ? [] : [step]; },
    markStepRunning(id) { this.steps[id].state = 'RUNNING'; },
    markStepCompleted(id, result) { this.steps[id].state = 'COMPLETED'; this.steps[id].result = result; executions += 1; },
    markStepFailed() { throw new Error('unexpected step failure'); },
    transition(state) { this.state = state; },
    transitionAgentTo() {}
  };
  const lease = { workflowId: instance.workflowId, leaseId: 'lease-2', workerId: 'worker-2', fencingToken: 2, expiresAt: Date.now() + 3000, cancelled: false, deadlineAt: null, instance };
  const scheduler = {
    leaseDurationMs: 3000,
    async leaseAsync() { return lease; },
    async renewAsync() { return lease; },
    async assertCurrentAsync() { return true; },
    async persistAsync() {},
    async releaseAsync() { released = true; return true; },
    async retryAsync() { throw new Error('unexpected retry'); }
  };
  const registry = {
    async register(worker) { return worker; },
    async heartbeat() { throw Object.assign(new Error('registry unavailable'), { code: 'WORKER_REGISTRY_UNAVAILABLE' }); }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler,
    workerRegistry: registry,
    workerId: 'worker-2',
    workerLeaseMs: 3000,
    executor: async () => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return { ok: true };
    }
  });
  const result = await worker.tick();
  assert.equal(result, null);
  assert.equal(executions, 0, 'failed worker liveness must prevent committing the step result');
  assert.equal(released, true);
});


test('AsyncWorkflowWorker refuses to commit a step after fencing is lost during execution', async () => {
  let assertCalls = 0;
  let completed = false;
  let released = false;
  const step = { id: 'step-1' };
  const instance = {
    workflowId: 'fencing-loss-after-side-effect',
    state: 'RUNNING',
    cancelRequested: false,
    deadlineAt: null,
    definition: { steps: [step] },
    steps: { 'step-1': { state: 'READY' } },
    readySteps() { return completed ? [] : [step]; },
    markStepRunning(id) { this.steps[id].state = 'RUNNING'; },
    markStepCompleted() { completed = true; this.steps['step-1'].state = 'COMPLETED'; },
    markStepFailed() { throw new Error('unexpected step failure'); },
    transition(state) { this.state = state; }
  };
  const lease = {
    workflowId: instance.workflowId,
    leaseId: 'lease-fenced',
    fencingToken: 7,
    cancelled: false,
    deadlineAt: null,
    instance
  };
  const scheduler = {
    leaseDurationMs: 3000,
    async leaseAsync() { return lease; },
    async renewAsync() { return lease; },
    async assertCurrentAsync() {
      assertCalls += 1;
      if (assertCalls >= 2) throw Object.assign(new Error('stale fencing token'), { code: 'WORKFLOW_FENCING_REJECTED' });
      return true;
    },
    async persistAsync() { throw new Error('must not persist stale worker state'); },
    async releaseAsync() { released = true; return true; },
    async retryAsync() { throw new Error('unexpected retry'); }
  };

  const worker = new AsyncWorkflowWorker({
    scheduler,
    workerId: 'worker-fenced',
    executor: async () => ({ externalSideEffect: true })
  });

  const result = await worker.tick();

  assert.equal(result, null);
  assert.equal(completed, false, 'stale worker must not commit completion');
  assert.equal(assertCalls, 2, 'fencing must be checked before and after the side effect');
  assert.equal(released, true);
});
