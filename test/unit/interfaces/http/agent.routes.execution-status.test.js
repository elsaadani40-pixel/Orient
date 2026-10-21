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


test('task creation links the idempotent owner message to the Runtime execution', async () => {
  const linked = [];
  const routes = createAgentRoutes({
    createTask: async input => {
      assert.equal(input.goal, 'Perform a bounded task');
      assert.equal(input.idempotencyKey, 'owner-message-1');
      return { task: { id: 'exec-77' }, replayed: false };
    }
  }, {
    onTaskCreated: async entry => { linked.push(entry); }
  });
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); }
  };

  await routes.createTask({ headers: { 'idempotency-key': 'owner-message-1' }, ownerChatMessageId: 'owner-message-1' }, res, {
    goal: 'Perform a bounded task'
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.task.id, 'exec-77');
  assert.deepEqual(linked, [{
    executionId: 'exec-77',
    messageId: 'owner-message-1',
    idempotencyKey: 'owner-message-1',
    replayed: false
  }]);
});

test('completed task response persists only the validated final assistant answer', async () => {
  const saved = [];
  const routes = createAgentRoutes({
    getExecutionStatus: async executionId => ({ executionId, status: 'completed' }),
    getExecutionEvents: async () => [],
    getExecutionApprovals: async () => [],
    getFinalAnswer: async () => ({ text: 'Verified answer', status: 'available' })
  }, {
    onFinalAnswer: async entry => { saved.push(entry); }
  });
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); }
  };

  await routes.taskResponse({}, res, 'exec-42');

  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.assistant.text, 'Verified answer');
  assert.deepEqual(saved, [{ executionId: 'exec-42', text: 'Verified answer' }]);
});

test('task response does not persist an answer before Runtime completion', async () => {
  const saved = [];
  const routes = createAgentRoutes({
    getExecutionStatus: async executionId => ({ executionId, status: 'running' }),
    getExecutionEvents: async () => [],
    getExecutionApprovals: async () => [],
    getFinalAnswer: async () => ({ text: null, status: 'pending' })
  }, {
    onFinalAnswer: async entry => { saved.push(entry); }
  });
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); }
  };

  await routes.taskResponse({}, res, 'exec-43');

  assert.equal(res.status, 200);
  assert.deepEqual(saved, []);
});
