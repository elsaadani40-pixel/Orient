'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const createServer = require('../../src/interfaces/http/server');
const createAgentRoutes = require('../../src/interfaces/http/routes/agent.routes');
const OwnerAuthService = require('../../src/core/security/owner-auth-service');

const PASSWORD = ['owner', 'sse', 'integration', 'test'].join('-') + '-password';

async function readUntil(reader, predicate, timeoutMs = 4000) {
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for SSE data')), remaining))
    ]);
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
    if (predicate(text)) return text;
  }
  throw new Error('SSE condition not met before timeout');
}

test('owner-authenticated SSE reconnect resumes after Last-Event-ID without replaying delivered events', async t => {
  const events = [
    { id: 'event-1', type: 'execution.started', executionId: 'exec-sse-1', timestamp: new Date().toISOString(), sequence: 1, data: { status: 'started' } },
    { id: 'event-2', type: 'tool.completed', executionId: 'exec-sse-1', timestamp: new Date().toISOString(), sequence: 2, data: { tool: 'project.audit', status: 'completed' } }
  ];
  const agentService = {
    async getExecutionEvents(executionId, { limit }) {
      assert.equal(executionId, 'exec-sse-1');
      return events.slice(-limit);
    }
  };
  const ownerAuth = new OwnerAuthService({ password: PASSWORD });
  const server = createServer({
    memoryRoutes: { home() {}, add() {}, delete() {} },
    agentRoutes: createAgentRoutes(agentService),
    ownerAuth
  });

  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(origin + '/executions/exec-sse-1/events');
  assert.equal(unauthorized.status, 401);

  const login = await fetch(origin + '/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: PASSWORD })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const firstController = new AbortController();
  const first = await fetch(origin + '/executions/exec-sse-1/events', {
    headers: { Cookie: cookie },
    signal: firstController.signal
  });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /text\/event-stream/);
  const firstReader = first.body.getReader();
  let firstText;
  try {
    firstText = await readUntil(firstReader, text => text.includes('id: event-1') && text.includes('id: event-2'));
  } finally {
    firstController.abort();
    await firstReader.cancel().catch(() => {});
  }
  assert.match(firstText, /id: event-1/);
  assert.match(firstText, /id: event-2/);

  const reconnectController = new AbortController();
  const reconnect = await fetch(origin + '/executions/exec-sse-1/events', {
    headers: { Cookie: cookie, 'Last-Event-ID': 'event-1' },
    signal: reconnectController.signal
  });
  assert.equal(reconnect.status, 200);
  const reconnectReader = reconnect.body.getReader();
  let reconnectText;
  try {
    reconnectText = await readUntil(reconnectReader, text => text.includes('id: event-2'));
  } finally {
    reconnectController.abort();
    await reconnectReader.cancel().catch(() => {});
  }
  assert.doesNotMatch(reconnectText, /id: event-1\n/);
  assert.match(reconnectText, /id: event-2/);
});
