const test = require('node:test');
const assert = require('node:assert/strict');

const createServer = require('../../src/interfaces/http/server');

test('dashboard route serves the local control UI with security headers', async (t) => {
  const server = createServer({
    memoryRoutes: {
      home(_req, res) { res.writeHead(200); res.end('memory'); },
      add() {},
      delete() {}
    },
    agentRoutes: {}
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html; charset=utf-8/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(html, /ORIENT ONE/);
  assert.match(html, /fetch\('\/agent'/);
  assert.match(html, /تعذر الاتصال بالخادم/);
  assert.match(html, /SERVER STATUS/);
  assert.match(html, /طلبات أعادت استجابة ناجحة في هذه الجلسة/);
  assert.match(html, /id="orientScene"/);
  assert.match(html, /src="\/command-scene.js"/);
  assert.match(html, /id="loadExecutionStatus"/);
  assert.match(html, /id="loadExecutionApprovals"/);
  assert.match(html, /id="heroExecutionState"/);
  assert.match(html, /extractExecutionState/);
  assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/);
});

test('WebGL command scene is served locally with a JavaScript content type', async (t) => {
  const server = createServer({
    memoryRoutes: { home(_req, res) { res.writeHead(200); res.end('memory'); }, add() {}, delete() {} },
    agentRoutes: {}
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/command-scene.js`);
  const source = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/javascript; charset=utf-8/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.match(source, /getContext\('webgl'/);
  assert.match(source, /CSS FALLBACK/);
  assert.match(source, /window\.ORIENTScene/);
  assert.match(source, /drawSphere\(core, activeTint/);
});

test('execution status and approval reads dispatch through existing agent routes', async (t) => {
  const server = createServer({
    memoryRoutes: { home(_req, res) { res.writeHead(200); res.end('memory'); }, add() {}, delete() {} },
    agentRoutes: {
      async status(_req, res, executionId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: executionId, state: 'observed-by-test' }));
      },
      async approvals(_req, res, executionId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: executionId, approvals: [] }));
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const status = await fetch(base + '/executions/exec%20one');
  assert.deepEqual(await status.json(), { id: 'exec one', state: 'observed-by-test' });
  const approvals = await fetch(base + '/executions/exec%20one/approvals');
  assert.deepEqual(await approvals.json(), { id: 'exec one', approvals: [] });
});

test('execution event stream replays after Last-Event-ID and excludes unapproved event data', async (t) => {
  const events = [
    { id: 'event-1', type: 'execution.step.started', executionId: 'exec one', timestamp: '2026-10-10T10:00:00.000Z', sequence: 1, data: { step: 1, tool: 'memory.read', secret: 'must-not-leak' } },
    { id: 'event-2', type: 'execution.step.completed', executionId: 'exec one', timestamp: '2026-10-10T10:00:01.000Z', sequence: 2, data: { step: 2, tool: 'memory.write', secret: 'must-not-leak' } }
  ];
  const createAgentRoutes = require('../../src/interfaces/http/routes/agent.routes');
  const server = createServer({
    memoryRoutes: { home(_req, res) { res.writeHead(200); res.end('memory'); }, add() {}, delete() {} },
    agentRoutes: createAgentRoutes({
      async getExecutionEvents(executionId, options) {
        assert.equal(executionId, 'exec one');
        assert.equal(options.limit, 200);
        return events;
      }
    })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const controller = new AbortController();
  const address = server.address();
  const response = await fetch('http://127.0.0.1:' + address.port + '/executions/exec%20one/events', {
    headers: { 'Last-Event-ID': 'event-1' },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body.getReader();
  let chunk = '';
  while (!chunk.includes('id: event-2')) {
    const part = await reader.read();
    if (part.done) break;
    chunk += new TextDecoder().decode(part.value);
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  assert.match(chunk, /id: event-2/);
  assert.match(chunk, /execution\.step\.completed/);
  assert.doesNotMatch(chunk, /event-1/);
  assert.doesNotMatch(chunk, /must-not-leak/);
});

test('dashboard does not replace the existing memory home route', async (t) => {
  const server = createServer({
    memoryRoutes: {
      home(_req, res) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('existing-memory-home'); },
      add() {},
      delete() {}
    },
    agentRoutes: {}
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'existing-memory-home');
});
