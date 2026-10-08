'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const createAgentRoutes = require('../../../../src/interfaces/http/routes/agent.routes');

test('agent cancellation route forwards reason and returns durable cancellation state', async () => {
  let received = null;
  const routes = createAgentRoutes({
    cancelExecution: async (executionId, options) => {
      received = { executionId, options };
      return {
        executionId,
        status: 'running',
        cancellationRequested: true,
        cancellationReason: options.reason
      };
    }
  });

  const res = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = JSON.parse(body);
    }
  };

  await routes.cancel({}, res, 'exec-1', JSON.stringify({ reason: 'stop now' }));

  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(received, {
    executionId: 'exec-1',
    options: { reason: 'stop now' }
  });
  assert.equal(res.body.cancellationRequested, true);
});
