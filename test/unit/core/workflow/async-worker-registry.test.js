const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowWorkerService = require('../../../../src/core/workflow/async-workflow-worker-service');

test('worker service registers with a durable identity before executing work', async () => {
  const calls = [];
  const registry = {
    async register(worker) {
      calls.push(['register', worker]);
      return worker;
    },
    async unregister(workerId, tenantId) {
      calls.push(['unregister', workerId, tenantId]);
      return true;
    }
  };
  let workerId = null;
  const scheduler = { tenantId: 'tenant-a', async recoverPersisted() {} };
  const service = new AsyncWorkflowWorkerService({
    scheduler,
    workerId: 'worker-a',
    workerRegistry: registry,
    workerFactory(id) {
      workerId = id;
      return { async tick() { return { state: 'COMPLETED' }; } };
    }
  });

  await service.runOnce();
  assert.equal(workerId, 'worker-a');
  assert.equal(calls[0][0], 'register');
  assert.equal(calls[0][1].tenantId, 'tenant-a');
});

test('worker service unregisters its durable identity during stopAndDrain', async () => {
  const calls = [];
  const registry = {
    async register(worker) { calls.push(['register', worker]); },
    async unregister(workerId, tenantId) { calls.push(['unregister', workerId, tenantId]); return true; }
  };
  const scheduler = { tenantId: 'tenant-a' };
  const service = new AsyncWorkflowWorkerService({
    scheduler,
    workerId: 'worker-a',
    workerRegistry: registry,
    workerFactory: () => ({ async tick() { return null; } })
  });

  service.start();
  await service.drain();
  await service.stopAndDrain();
  assert.ok(calls.some(call => call[0] === 'unregister' && call[1] === 'worker-a' && call[2] === 'tenant-a'));
});

test('worker service propagates registry failure through onError and does not execute work', async () => {
  let executed = false;
  let captured = null;
  const registry = {
    async register() {
      throw Object.assign(new Error('registry unavailable'), { code: 'WORKER_REGISTRY_UNAVAILABLE' });
    }
  };
  const service = new AsyncWorkflowWorkerService({
    scheduler: { tenantId: 'tenant-a' },
    workerRegistry: registry,
    workerFactory: () => {
      executed = true;
      return { async tick() { return null; } };
    },
    onError(error) { captured = error; }
  });

  const result = await service.runOnce();
  assert.equal(result, null);
  assert.equal(executed, false);
  assert.equal(captured.code, 'WORKER_REGISTRY_UNAVAILABLE');
});
