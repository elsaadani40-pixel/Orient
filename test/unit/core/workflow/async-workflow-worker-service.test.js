const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowWorkerService = require('../../../../src/core/workflow/async-workflow-worker-service');

test('AsyncWorkflowWorkerService serializes polling and performs durable recovery', async () => {
  let now = 0;
  let recoveries = 0;
  let ticks = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const errors = [];

  const scheduler = {
    async recoverPersisted() {
      recoveries += 1;
    }
  };

  const workerFactory = () => ({
    async tick() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 20));
      ticks += 1;
      concurrent -= 1;
      return { state: 'COMPLETED' };
    }
  });

  const service = new AsyncWorkflowWorkerService({
    scheduler,
    workerFactory,
    pollIntervalMs: 50,
    recoveryIntervalMs: 50,
    clock: () => now,
    onError: error => errors.push(error)
  });

  const first = service.runOnce();
  const second = service.runOnce();
  assert.equal(first, second);

  await first;
  assert.equal(ticks, 1);
  assert.equal(recoveries, 1);
  assert.equal(maxConcurrent, 1);

  now = 100;
  await service.runOnce();
  assert.equal(ticks, 2);
  assert.equal(recoveries, 2);
  assert.deepEqual(errors, []);

  assert.equal(service.start(), true);
  assert.equal(service.start(), false);
  assert.equal(service.isRunning(), true);
  service.stop();
  assert.equal(service.isRunning(), false);
  assert.equal(service.stop(), false);
});
