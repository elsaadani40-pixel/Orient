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


test('agent resume route passes durable approval payload to service', async () => {
  let received = null;
  const routes = createAgentRoutes({
    getExecutionStatus: () => ({ executionId: 'exec-1', status: 'running' }),
    resumeExecution: async (executionId, options) => {
      received = { executionId, options };
      return { resumed: true, requestId: 'req-1' };
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

  await routes.resume({}, res, 'exec-1', JSON.stringify({
    approval: { approvalId: 'approval-1' }
  }));

  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(received, {
    executionId: 'exec-1',
    options: { approval: { approvalId: 'approval-1' } }
  });
  assert.deepEqual(res.body, { resumed: true, requestId: 'req-1' });
});


test('agent approvals route returns only service-provided durable approval state', async () => {
  const expected = [{
    approvalId: 'approval-1',
    executionId: 'exec-1',
    step: 2,
    tool: 'dangerous.tool',
    capability: 'dangerous.capability'
  }];

  const routes = createAgentRoutes({
    getExecutionStatus: () => ({ executionId: 'exec-1', status: 'running' }),
    getExecutionApprovals: async executionId => {
      assert.equal(executionId, 'exec-1');
      return expected;
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

  await routes.approvals({}, res, 'exec-1');

  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, expected);
});
