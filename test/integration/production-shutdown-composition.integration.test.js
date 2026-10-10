'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createProductionShutdownCoordinator =
  require('../../src/core/runtime/production-shutdown-composition');

test('production shutdown composition drains only after HTTP ingress and in-flight requests close', async () => {
  const order = [];
  let releaseRequest;
  let markRequestStarted;
  const requestStarted = new Promise(resolve => { markRequestStarted = resolve; });
  const requestGate = new Promise(resolve => { releaseRequest = resolve; });

  const server = http.createServer(async (_request, response) => {
    order.push('request-start');
    markRequestStarted();
    await requestGate;
    order.push('request-finished');
    response.end('ok');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const coordinator = createProductionShutdownCoordinator({
    server,
    workerService: {
      async stopAndDrain() {
        order.push('worker-drain-start');
        await Promise.resolve();
        order.push('worker-drain-complete');
      }
    },
    runtime: {
      async shutdown() { order.push('runtime-shutdown'); }
    },
    eventStoreSubscriber: {
      stop() { order.push('subscriber-stop'); }
    },
    persistenceRuntime: {
      async close() { order.push('persistence-close'); }
    }
  });

  const requestPromise = new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:' + server.address().port, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on('error', reject);
  });

  try {
    await requestStarted;
    const shutdownPromise = coordinator.shutdown();

    // server.close must wait for the already accepted request, so the worker
    // cannot drain and Runtime cannot stop while that request is still active.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['request-start']);

    releaseRequest();
    assert.deepEqual(await requestPromise, { statusCode: 200, body: 'ok' });
    const result = await shutdownPromise;

    assert.equal(result.completed, true);
    assert.deepEqual(order, [
      'request-start',
      'request-finished',
      'worker-drain-start',
      'worker-drain-complete',
      'runtime-shutdown',
      'subscriber-stop',
      'persistence-close'
    ]);
  } finally {
    releaseRequest();
    if (server.listening) {
      await new Promise(resolve => server.close(resolve));
    }
  }
});
