const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowWorkerService = require('../../../../src/core/workflow/async-workflow-worker-service');

test('AsyncWorkflowWorkerService serializes polling and performs durable recovery', async () => {
  let now = 0;
  let recoveries = 0;
  let recoveryCapabilities = null;
  let factoryCapabilities = null;
  let recoveryPrincipal = null;
  let factoryPrincipal = null;
  let ticks = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const errors = [];

  const scheduler = {
    async recoverPersisted(workerId, capabilities, workerPrincipal) {
      recoveries += 1;
      recoveryCapabilities = { workerId, capabilities };
      recoveryPrincipal = workerPrincipal;
    }
  };

  const workerFactory = (workerId, capabilities, workerPrincipal) => {
    factoryCapabilities = { workerId, capabilities };
    factoryPrincipal = workerPrincipal;
    return ({
    async tick() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 20));
      ticks += 1;
      concurrent -= 1;
      return { state: 'COMPLETED' };
    }
    });
  };

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
  assert.deepEqual(factoryCapabilities, { workerId: service.workerId, capabilities: ['web.search', 'calendar.read'] });
  assert.equal(recoveryPrincipal, service.workerPrincipal);
  assert.equal(factoryPrincipal, service.workerPrincipal);
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


test('AsyncWorkflowWorkerService uses one trusted worker session for registration heartbeat recovery and shutdown', async () => {
  const calls = [];
  const scheduler = {
    tenantId: 'tenant-worker',
    async recoverPersisted(workerId, capabilities, workerPrincipal) {
      calls.push(['recover', workerId, workerPrincipal]);
      return 0;
    }
  };
  const registry = {
    async register(worker, tenantId, options) {
      calls.push(['register', worker.workerId, tenantId, options.workerPrincipal]);
      return worker;
    },
    async heartbeat(workerId, options) {
      calls.push(['heartbeat', workerId, options.workerPrincipal]);
      return true;
    },
    async unregister(workerId, tenantId, options) {
      calls.push(['unregister', workerId, tenantId, options.workerPrincipal]);
      return true;
    }
  };
  const service = new AsyncWorkflowWorkerService({
    scheduler,
    workerRegistry: registry,
    workerId: 'worker-session-test',
    workerCapabilities: ['runtime', 'memory.read'],
    workerFactory: (workerId, capabilities, workerPrincipal) => ({
      workerId, capabilities, workerPrincipal,
      async tick() { return { state: 'COMPLETED' }; }
    }),
    pollIntervalMs: 50,
    recoveryIntervalMs: 50
  });

  await service.ensureWorkerRegistered();
  await service.heartbeatWorker();
  await service.runOnce();
  await service.unregisterWorker();

  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call[call.length - 1] === service.workerPrincipal));
  assert.equal(service.workerPrincipal.workerId, 'worker-session-test');
  assert.equal(service.workerPrincipal.tenantId, 'tenant-worker');
  assert.deepEqual(service.workerPrincipal.capabilities, ['memory.read', 'runtime']);
});


test('AsyncWorkflowWorkerService stops polling and unregisters its session when durable worker fencing is unavailable', async () => {
  const errors = [];
  const calls = [];
  const workerRegistry = {
    async register(worker, tenantId) {
      calls.push(['register', worker.workerId, tenantId]);
      return worker;
    },
    async unregister(workerId, tenantId) {
      calls.push(['unregister', workerId, tenantId]);
      return true;
    }
  };
  const service = new AsyncWorkflowWorkerService({
    scheduler: { tenantId: 'tenant-fencing', async recoverPersisted() {} },
    workerRegistry,
    workerId: 'worker-fencing',
    workerFactory: () => ({
      async tick() {
        throw Object.assign(new Error('SQLite worker fencing is unavailable'), {
          code: 'WORKER_DURABLE_FENCING_UNSUPPORTED'
        });
      }
    }),
    pollIntervalMs: 50,
    recoveryIntervalMs: 50,
    onError: error => errors.push(error)
  });

  await service.runOnce();
  assert.equal(service.stopRequested, true);
  assert.equal(service.running, false);
  assert.equal(service.timer, null);
  assert.equal(service.heartbeatTimer, null);
  assert.equal(service.workerRegistered, false);
  assert.deepEqual(calls, [
    ['register', 'worker-fencing', 'tenant-fencing'],
    ['unregister', 'worker-fencing', 'tenant-fencing']
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'WORKER_DURABLE_FENCING_UNSUPPORTED');
});
