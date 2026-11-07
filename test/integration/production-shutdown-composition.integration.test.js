'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shutdownInOrder = require('../../src/core/runtime/shutdown-in-order');
const createProductionShutdownStages = require('../../src/core/runtime/production-shutdown-stages');

test('production shutdown composition drains each stage in the required order', async () => {
  const order = [];
  const server = {
    close(callback) {
      order.push('http-ingress');
      callback(null);
    }
  };
  const stages = createProductionShutdownStages({
    server,
    eventStoreSubscriber: {
      async stop() { order.push('observations'); }
    },
    stopWorkers: async () => { order.push('workers'); },
    runtime: {
      async shutdown(options) {
        assert.deepEqual(options, { cancelQueued: false });
        order.push('runtime');
      }
    },
    persistenceRuntime: {
      async close() { order.push('persistence'); }
    }
  });

  const failures = await shutdownInOrder(stages);
  assert.deepEqual(failures, []);
  assert.deepEqual(order, [
    'http-ingress',
    'observations',
    'workers',
    'runtime',
    'persistence'
  ]);
});

test('production shutdown composition never stops Runtime or persistence when ingress close fails', async () => {
  const order = [];
  const logged = [];
  const stages = createProductionShutdownStages({
    server: {
      close(callback) {
        order.push('http-ingress');
        callback(new Error('ingress close failed'));
      }
    },
    eventStoreSubscriber: {
      async stop() { order.push('observations'); }
    },
    stopWorkers: async () => { order.push('workers'); },
    runtime: {
      async shutdown() { order.push('runtime'); }
    },
    persistenceRuntime: {
      async close() { order.push('persistence'); }
    },
    logger: {
      error(message, details) { logged.push({ message, details }); }
    }
  });

  const failures = await shutdownInOrder(stages);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, 'http-ingress');
  assert.deepEqual(order, ['http-ingress']);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].details.stage, 'http-ingress');
});

test('production shutdown composition allows a missing persistence close hook', async () => {
  const order = [];
  const stages = createProductionShutdownStages({
    server: {
      close(callback) {
        order.push('http-ingress');
        callback(null);
      }
    },
    eventStoreSubscriber: {
      async stop() { order.push('observations'); }
    },
    runtime: {
      async shutdown() { order.push('runtime'); }
    }
  });

  await shutdownInOrder(stages);
  assert.deepEqual(order, ['http-ingress', 'observations', 'runtime']);
});
