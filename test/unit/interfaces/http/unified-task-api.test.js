'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createAgentRoutes = require('../../../../src/interfaces/http/routes/agent.routes');
const createServer = require('../../../../src/interfaces/http/server');
const { once } = require('node:events');

function responseRecorder() {
  return {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ? JSON.parse(body) : null;
    }
  };
}

test('v1 task events are cursor-paginated and redact untrusted event payloads', async () => {
  const source = [
    { id: 'event-1', executionId: 'exec-1', sequence: 1, timestamp: '2026-10-10T10:00:00.000Z', type: 'step.started', data: { stepId: 'step-1', tool: 'safe.tool', token: 'secret-value', status: 'running' } },
    { id: 'event-2', executionId: 'exec-1', sequence: 2, timestamp: '2026-10-10T10:00:01.000Z', type: 'step.completed', data: { stepId: 'step-1', status: 'completed', rawOutput: 'private output' } },
    { id: 'event-3', executionId: 'exec-1', sequence: 3, timestamp: '2026-10-10T10:00:02.000Z', type: 'goal.completed', data: { status: 'completed' } }
  ];
  const routes = createAgentRoutes({
    async getExecutionEvents(id, options) {
      assert.equal(id, 'exec-1');
      assert.deepEqual(options, { limit: 200 });
      return source;
    }
  });
  const res = responseRecorder();
  await routes.taskEvents({ url: '/api/v1/tasks/exec-1/events?limit=1' }, res, 'exec-1');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, {
    apiVersion: 'v1',
    items: [{
      id: 'event-1',
      taskId: 'exec-1',
      sequence: 1,
      timestamp: '2026-10-10T10:00:00.000Z',
      type: 'step.started',
      stepId: 'step-1',
      outcome: 'running',
      details: { stepId: 'step-1', tool: 'safe.tool', status: 'running' }
    }],
    page: { limit: 1, nextCursor: 'event-1', hasMore: true, gapDetected: false }
  });
  assert.equal(JSON.stringify(res.body).includes('secret-value'), false);
  assert.equal(JSON.stringify(res.body).includes('private output'), false);

  const next = responseRecorder();
  await routes.taskEvents({ url: '/api/v1/tasks/exec-1/events?limit=1&after=event-1' }, next, 'exec-1');
  assert.equal(next.body.items[0].id, 'event-2');
  assert.equal(next.body.page.nextCursor, 'event-2');
});

test('v1 task events fail closed for expired cursors and invalid limits', async () => {
  const routes = createAgentRoutes({
    async getExecutionEvents() {
      return [{ id: 'new-event', sequence: 201, type: 'goal.updated', data: {} }];
    }
  });
  await assert.rejects(
    routes.taskEvents({ url: '/api/v1/tasks/exec-1/events?after=old-event' }, responseRecorder(), 'exec-1'),
    error => error.code === 'EVENT_CURSOR_NOT_FOUND' && error.statusCode === 409
  );
  await assert.rejects(
    routes.taskEvents({ url: '/api/v1/tasks/exec-1/events?limit=101' }, responseRecorder(), 'exec-1'),
    error => error.code === 'VALIDATION_ERROR' && error.statusCode === 400
  );
});

test('v1 task list maps only bounded durable execution summaries', async () => {
  const routes = createAgentRoutes({
    async listExecutionSummaries(options) {
      assert.deepEqual(options, { limit: 20, offset: 0 });
      return {
        total: 1,
        limit: 20,
        offset: 0,
        executions: [{
          executionId: 'exec-1',
          status: 'completed',
          currentStep: 2,
          startedAt: '2026-10-10T10:00:00.000Z',
          updatedAt: '2026-10-10T10:01:00.000Z',
          completedAt: '2026-10-10T10:01:00.000Z',
          cancellationRequested: false,
          tenantId: 'must-not-be-exposed',
          result: { private: 'must-not-be-exposed' }
        }]
      };
    }
  });
  const res = responseRecorder();
  await routes.tasks({ url: '/api/v1/tasks' }, res);

  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-ORIENT-API-Version'], 'v1');
  assert.deepEqual(res.body, {
    apiVersion: 'v1',
    items: [{
      id: 'exec-1',
      status: 'completed',
      currentStep: 2,
      createdAt: '2026-10-10T10:00:00.000Z',
      updatedAt: '2026-10-10T10:01:00.000Z',
      completedAt: '2026-10-10T10:01:00.000Z',
      cancellationRequested: false,
      version: 1
    }],
    page: { limit: 20, offset: 0, total: 1 }
  });
});

test('v1 task list rejects invalid pagination', async () => {
  const routes = createAgentRoutes({
    async listExecutionSummaries() {
      assert.fail('invalid pagination must not reach the service');
    }
  });
  await assert.rejects(
    routes.tasks({ url: '/api/v1/tasks?limit=101' }, responseRecorder()),
    error => error.code === 'VALIDATION_ERROR' && error.statusCode === 400
  );
});

test('v1 task detail omits tenant identifiers and raw execution result', async () => {
  const routes = createAgentRoutes({
    async getExecutionStatus(id) {
      assert.equal(id, 'exec-2');
      return {
        executionId: id,
        status: 'running',
        tenantId: 'private-tenant',
        result: { secret: 'do-not-return' },
        currentStep: 1,
        startedAt: '2026-10-10T10:00:00.000Z'
      };
    }
  });
  const res = responseRecorder();
  await routes.task({}, res, 'exec-2');

  assert.deepEqual(res.body, {
    apiVersion: 'v1',
    task: {
      id: 'exec-2',
      status: 'running',
      currentStep: 1,
      createdAt: '2026-10-10T10:00:00.000Z',
      updatedAt: null,
      completedAt: null,
      cancellationRequested: false,
      agentLifecycle: null,
      version: 1
    }
  });
});

test('v1 task read endpoints remain behind the shared owner-session gate', async t => {
  const server = createServer({
    memoryRoutes: { home() {}, add() {}, delete() {} },
    agentRoutes: {
      async tasks(_req, res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ apiVersion: 'v1', items: [] }));
      },
      async taskEvents(_req, res, id) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ apiVersion: 'v1', items: [{ taskId: id }] }));
      },
      async task(_req, res, id) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ apiVersion: 'v1', task: { id } }));
      }
    },
    ownerAuth: {
      enabled: true,
      authenticate(token) {
        return token === 'valid-session'
          ? { sessionId: 'session-1', csrfToken: 'csrf-1', expiresAt: Date.now() + 60000 }
          : null;
      }
    }
  });

  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  const denied = await fetch(`${origin}/api/v1/tasks`);
  assert.equal(denied.status, 401);

  const list = await fetch(`${origin}/api/v1/tasks?limit=20`, {
    headers: { Cookie: 'orient_owner_session=valid-session' }
  });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).apiVersion, 'v1');

  const deniedEvents = await fetch(`${origin}/api/v1/tasks/exec-3/events`);
  assert.equal(deniedEvents.status, 401);

  const events = await fetch(`${origin}/api/v1/tasks/exec-3/events`, {
    headers: { Cookie: 'orient_owner_session=valid-session' }
  });
  assert.equal(events.status, 200);
  assert.equal((await events.json()).items[0].taskId, 'exec-3');

  const detail = await fetch(`${origin}/api/v1/tasks/exec-3`, {
    headers: { Cookie: 'orient_owner_session=valid-session' }
  });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).task.id, 'exec-3');
});
