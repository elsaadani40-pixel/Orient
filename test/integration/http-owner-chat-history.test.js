'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const createServer = require('../../src/interfaces/http/server');
const OwnerAuthService = require('../../src/core/security/owner-auth-service');

test('owner chat history and submission require owner session, CSRF, and persist idempotently', async t => {
  const password = 'owner-chat-integration-secret-2026';
  const messages = [];
  const store = {
    async list() { return messages.slice(); },
    async append(message) {
      const existing = messages.find(item => item.id === message.id);
      if (existing) {
        if (existing.role !== message.role || existing.content !== message.content) {
          throw Object.assign(new Error('Idempotency conflict'), { code: 'OWNER_CHAT_IDEMPOTENCY_CONFLICT' });
        }
        return existing;
      }
      messages.push({ ...message, createdAt: new Date().toISOString() });
      return messages[messages.length - 1];
    }
  };
  const agentRoutes = {
    async createTask(req, res, body) {
      assert.equal(req.headers['idempotency-key'], 'chat-message-key-0001');
      assert.deepEqual(JSON.parse(body), { goal: 'مرحبا يا ORIENT' });
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ apiVersion: 'v1', task: { id: 'task-1' }, replayed: false }));
    }
  };
  const server = createServer({
    memoryRoutes: { home() {}, add() {}, delete() {} },
    agentRoutes,
    ownerAuth: new OwnerAuthService({ password }),
    ownerChatStore: store
  });

  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  const deniedHistory = await fetch(origin + '/owner/chat/history');
  assert.equal(deniedHistory.status, 401);

  const login = await fetch(origin + '/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ password })
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const deniedCsrf = await fetch(origin + '/owner/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin, Cookie: cookie, 'Idempotency-Key': 'chat-message-key-0001' },
    body: JSON.stringify({ message: 'مرحبا يا ORIENT' })
  });
  assert.equal(deniedCsrf.status, 403);
  assert.equal(messages.length, 0);

  const submitted = await fetch(origin + '/owner/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: origin,
      Cookie: cookie,
      'X-ORIENT-CSRF': session.csrfToken,
      'Idempotency-Key': 'chat-message-key-0001'
    },
    body: JSON.stringify({ message: 'مرحبا يا ORIENT' })
  });
  assert.equal(submitted.status, 201);
  assert.equal((await submitted.json()).task.id, 'task-1');
  assert.equal(messages.length, 1);
  assert.deepEqual({ id: messages[0].id, role: messages[0].role, content: messages[0].content }, {
    id: 'chat-message-key-0001',
    role: 'user',
    content: 'مرحبا يا ORIENT'
  });

  const history = await fetch(origin + '/owner/chat/history', { headers: { Cookie: cookie } });
  assert.equal(history.status, 200);
  assert.equal((await history.json()).messages.length, 1);
});
