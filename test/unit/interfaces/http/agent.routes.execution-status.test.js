'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const createAgentRoutes = require('../../../../src/interfaces/http/routes/agent.routes');

test('agent status route returns durable execution status without cache', async () => {
  let response = null;
  const routes = createAgentRoutes({
    getExecutionStatus: executionId => ({
      executionId,
      status: 'running'
    })
  });

  const res = {
    writeHead(status, headers) {
      response = { status, headers };
    },
    end(body) {
      response.body = JSON.parse(body);
    }
  };

  await routes.status({}, res, 'exec-1');

  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(response.body, {
    executionId: 'exec-1',
    status: 'running'
  });
});
