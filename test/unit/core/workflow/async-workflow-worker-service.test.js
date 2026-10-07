const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowWorkerService = require('../../../../src/core/workflow/async-workflow-worker-service');

test('AsyncWorkflowWorkerService serializes polling and performs durable recovery', async () => {
  let now = 0;
  let recoveries = 0;
  let recoveryCapabilities = null;
  let ticks = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const errors = [];

  const scheduler = {
    async recoverPersisted(workerId, capabilities) {
      recoveries += 1;
      recoveryCapabilities = { workerId, capabilities };
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
    onError: error => errors.push(error),
    workerCapabilities: ['web.search', 'calendar.read']
  });

  const first = service.runOnce();
  const second = service.runOnce();
  assert.equal(first, second);

  await first;
  assert.equal(ticks, 1);
  assert.equal(recoveries, 1);
  assert.deepEqual(recoveryCapabilities, { workerId: service.workerId, capabilities: ['web.search', 'calendar.read'] });
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


test('AsyncWorkflowWorkerService stopAndDrain waits for an in-flight tick', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let ticks = 0;
  const service = new AsyncWorkflowWorkerService({
    scheduler: { async recoverPersisted() {} },
    workerFactory: () => ({
      async tick() {
        ticks += 1;
        await gate;
        return { state: 'COMPLETED' };
      }
    }),
    pollIntervalMs: 50,
    recoveryIntervalMs: 50
  });

  const run = service.runOnce();
  const stopping = service.stopAndDrain();
  let drained = false;
  void stopping.then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await stopping;
  await run;
  assert.equal(drained, true);
  assert.equal(ticks, 1);
  assert.equal(service.isRunning(), false);
});


test('AsyncWorkflowWorkerService rejects a polling race after shutdown', async () => {
  let ticks = 0;
  const service = new AsyncWorkflowWorkerService({
    scheduler: { async recoverPersisted() {} },
    workerFactory: () => ({
      async tick() {
        ticks += 1;
        return { state: 'COMPLETED' };
      }
    }),
    pollIntervalMs: 50,
    recoveryIntervalMs: 50
  });

  assert.equal(await service.stopAndDrain(), false);
  assert.equal(await service.runOnce(), null);
  assert.equal(ticks, 0);

  assert.equal(service.start(), true);
  await service.drain();
  assert.equal(ticks, 1);
  assert.equal(service.stop(), true);
});

test('AsyncWorkflowScheduler does not reserve quota after shutdown begins', async () => {
  const AsyncWorkflowScheduler = require('../../../../src/core/workflow/async-workflow-scheduler');

  let reservations = 0;
  const scheduler = new AsyncWorkflowScheduler({
    quotaRepository: {
      async reserveWorkflow() {
        reservations += 1;
      }
    }
  });

  scheduler.shutdown();

  await assert.rejects(
    () => scheduler.enqueueDurable(null),
    error => error?.code === 'SCHEDULER_SHUTTING_DOWN'
  );
  assert.equal(reservations, 0);
});
