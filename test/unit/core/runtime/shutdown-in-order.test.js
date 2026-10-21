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

test('shutdown continues to later stages when an earlier stage fails', async () => {
  const order = [];
  const errors = [];
  await shutdownInOrder({
    closeIngress: async () => { order.push('http-ingress'); throw new Error('close failed'); },
    stopObservations: async () => { order.push('observations'); },
    stopWorkers: async () => { order.push('workers'); },
    shutdownRuntime: async () => { order.push('runtime'); },
    closePersistence: async () => { order.push('persistence'); },
    onError: (stage, error) => errors.push({ stage, message: error.message })
  });
  assert.deepEqual(order, ['http-ingress', 'observations', 'workers', 'runtime', 'persistence']);
  assert.deepEqual(errors, [{ stage: 'http-ingress', message: 'close failed' }]);
});
