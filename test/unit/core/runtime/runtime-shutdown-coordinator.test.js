'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RuntimeShutdownCoordinator = require('../../../../src/core/runtime/runtime-shutdown-coordinator');

test('RuntimeShutdownCoordinator closes HTTP ingress, drains workers, then shuts down runtime and persistence', async () => {
  const order = [];
  let closeCallback;
  const coordinator = new RuntimeShutdownCoordinator({
    server: {
      listening: true,
      close(callback) {
        order.push('http-close-start');
        closeCallback = callback;
      }
    },
    eventStoreSubscriber: { stop() { order.push('subscriber-stop'); } },
    workerService: {
      async stopAndDrain() {
        order.push('worker-drain-start');
        await new Promise(resolve => setImmediate(resolve));
        order.push('worker-drain-complete');
      }
    },
    runtime: {
      async shutdown(options) {
        assert.deepEqual(options, { cancelQueued: false });
        order.push('runtime-shutdown');
      }
    },
    persistenceRuntime: {
      async close() { order.push('persistence-close'); }
    }
  });

  const shutdown = coordinator.shutdown({ runtimeOptions: { cancelQueued: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['subscriber-stop', 'http-close-start']);
  closeCallback();
  const result = await shutdown;

  assert.equal(result.completed, true);
  assert.deepEqual(order, [
    'http-close-start',
    'worker-drain-start',
    'worker-drain-complete',
    'runtime-shutdown',
    'subscriber-stop',
    'persistence-close'
  ]);
});

test('RuntimeShutdownCoordinator shares one shutdown operation across repeated signals', async () => {
  let runtimeCalls = 0;
  let persistenceCalls = 0;
  const coordinator = new RuntimeShutdownCoordinator({
    server: { listening: false, close() { assert.fail('non-listening server must not close'); } },
    runtime: { async shutdown() { runtimeCalls += 1; } },
    persistenceRuntime: { async close() { persistenceCalls += 1; } }
  });

  const first = coordinator.shutdown();
  const second = coordinator.shutdown();
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.completed, true);
  assert.equal(runtimeCalls, 1);
  assert.equal(persistenceCalls, 1);
});

test('RuntimeShutdownCoordinator continues cleanup after a worker drain failure and reports degraded shutdown', async () => {
  const order = [];
  const errors = [];
  const coordinator = new RuntimeShutdownCoordinator({
    server: { listening: false },
    workerService: { async stopAndDrain() { order.push('worker'); throw Object.assign(new Error('drain failed'), { code: 'DRAIN_FAILED' }); } },
    runtime: { async shutdown() { order.push('runtime'); } },
    persistenceRuntime: { async close() { order.push('persistence'); } },
    onError(error, stage) { errors.push({ code: error.code, stage }); }
  });

  const result = await coordinator.shutdown();
  assert.equal(result.completed, false);
  assert.deepEqual(order, ['worker', 'runtime', 'persistence']);
  assert.deepEqual(errors, [{ code: 'DRAIN_FAILED', stage: 'async-worker' }]);
  assert.equal(result.errors.length, 1);
});
