'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shutdownInOrder = require('../../../../src/core/runtime/shutdown-in-order');

test('shutdown closes HTTP ingress before observations, workers, runtime, and persistence', async () => {
  const order = [];
  await shutdownInOrder({
    closeIngress: async () => { order.push('http-ingress'); },
    stopObservations: async () => { order.push('observations'); },
    stopWorkers: async () => { order.push('workers'); },
    shutdownRuntime: async () => { order.push('runtime'); },
    closePersistence: async () => { order.push('persistence'); }
  });
  assert.deepEqual(order, ['http-ingress', 'observations', 'workers', 'runtime', 'persistence']);
});

test('shutdown fails closed if HTTP ingress cannot be confirmed closed', async () => {
  const order = [];
  const errors = [];
  const failures = await shutdownInOrder({
    closeIngress: async () => { order.push('http-ingress'); throw new Error('close failed'); },
    stopObservations: async () => { order.push('observations'); },
    stopWorkers: async () => { order.push('workers'); },
    shutdownRuntime: async () => { order.push('runtime'); },
    closePersistence: async () => { order.push('persistence'); },
    onError: (stage, error) => errors.push({ stage, message: error.message })
  });
  assert.deepEqual(order, ['http-ingress']);
  assert.deepEqual(errors, [{ stage: 'http-ingress', message: 'close failed' }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, 'http-ingress');
  assert.match(failures[0].error.message, /close failed/);
});

test('shutdown continues cleanup after a non-ingress stage fails', async () => {
  const order = [];
  const failures = await shutdownInOrder({
    closeIngress: async () => { order.push('http-ingress'); },
    stopObservations: async () => { order.push('observations'); throw new Error('subscriber failed'); },
    stopWorkers: async () => { order.push('workers'); },
    shutdownRuntime: async () => { order.push('runtime'); },
    closePersistence: async () => { order.push('persistence'); }
  });
  assert.deepEqual(order, ['http-ingress', 'observations', 'workers', 'runtime', 'persistence']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, 'observations');
});
