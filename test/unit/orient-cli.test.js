'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient, resolveBaseUrl, readSession } = require('../../bin/orient');

function tempSession(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'session.json');
}

function response(status, data, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers[name.toLowerCase()] || null; } },
    async json() { return data; }
  };
}

test('ORIENT CLI only allows HTTPS remote origins and loopback HTTP', () => {
  assert.equal(resolveBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(resolveBaseUrl('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(resolveBaseUrl('https://orient.example/'), 'https://orient.example');
  assert.throws(() => resolveBaseUrl('http://orient.example'), /HTTPS/);
  assert.throws(() => resolveBaseUrl('http://127.0.0.1:8080/path'), /only an origin/);
  assert.throws(() => resolveBaseUrl('https://user:secret@orient.example'), /only an origin/);
});

test('login stores only session material with restrictive file mode and binds it to the server origin', async t => {
  const sessionFile = tempSession(t);
  const calls = [];
  const client = createClient({
    baseUrl: 'http://127.0.0.1:8080',
    sessionFile,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { csrfToken: 'c'.repeat(43), expiresAt: Date.now() + 60000, passwordChangeRequired: false }, {
        'set-cookie': 'orient_owner_session=' + 't'.repeat(43) + '; Path=/; HttpOnly; SameSite=Strict'
      });
    }
  });

  await client.login('never-log-this-password');
  const stored = readSession(sessionFile);
  assert.equal(stored.token, 't'.repeat(43));
  assert.equal(stored.csrfToken, 'c'.repeat(43));
  assert.equal(stored.baseUrl, 'http://127.0.0.1:8080');
  assert.equal(Object.hasOwn(stored, 'password'), false);
  assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  assert.equal(calls[0].options.headers.Origin, 'http://127.0.0.1:8080');
  assert.equal(JSON.parse(calls[0].options.body).password, 'never-log-this-password');
});

test('task creation uses the Runtime API with owner cookie, origin and CSRF token', async t => {
  const sessionFile = tempSession(t);
  const token = 't'.repeat(43);
  const csrf = 'c'.repeat(43);
  fs.writeFileSync(sessionFile, JSON.stringify({
    baseUrl: 'http://127.0.0.1:8080', token, csrfToken: csrf, expiresAt: Date.now() + 60000
  }), { mode: 0o600 });
  let call;
  const client = createClient({
    baseUrl: 'http://127.0.0.1:8080',
    sessionFile,
    fetchImpl: async (url, options) => {
      call = { url, options };
      return response(201, { apiVersion: 'v1', task: { id: 'task_123', status: 'queued' } });
    }
  });

  const result = await client.createTask('  prepare a safe plan  ');
  assert.equal(result.task.id, 'task_123');
  assert.equal(call.url, 'http://127.0.0.1:8080/api/v1/tasks');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Cookie, 'orient_owner_session=' + token);
  assert.equal(call.options.headers.Origin, 'http://127.0.0.1:8080');
  assert.equal(call.options.headers['X-ORIENT-CSRF'], csrf);
  const payload = JSON.parse(call.options.body);
  assert.equal(payload.goal, 'prepare a safe plan');
  assert.match(payload.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('CLI rejects malformed IDs, empty goals, expired sessions, and cross-server session reuse', async t => {
  const sessionFile = tempSession(t);
  const token = 't'.repeat(43);
  const csrf = 'c'.repeat(43);
  fs.writeFileSync(sessionFile, JSON.stringify({
    baseUrl: 'https://other.example', token, csrfToken: csrf, expiresAt: Date.now() + 60000
  }), { mode: 0o600 });
  const client = createClient({ baseUrl: 'https://orient.example', sessionFile, fetchImpl: async () => {
    throw new Error('network should not be reached');
  } });
  await assert.rejects(client.listTasks(), /belongs to another server/);
  await assert.rejects(client.showTask('bad/id'), /Invalid task ID/);
  await assert.rejects(client.createTask('   '), /Task goal/);

  fs.writeFileSync(sessionFile, JSON.stringify({
    baseUrl: 'https://orient.example', token, csrfToken: csrf, expiresAt: Date.now() - 1
  }), { mode: 0o600 });
  await assert.rejects(client.listTasks(), /expired/);
});

test('CLI clears its local session even if remote logout fails', async t => {
  const sessionFile = tempSession(t);
  fs.writeFileSync(sessionFile, JSON.stringify({
    baseUrl: 'http://127.0.0.1:8080', token: 't'.repeat(43),
    csrfToken: 'c'.repeat(43), expiresAt: Date.now() + 60000
  }), { mode: 0o600 });
  const client = createClient({
    baseUrl: 'http://127.0.0.1:8080',
    sessionFile,
    fetchImpl: async () => response(403, { code: 'OWNER_CSRF_REJECTED' })
  });
  await assert.rejects(client.logout(), /remote logout could not be confirmed/);
  assert.equal(fs.existsSync(sessionFile), false);
});

test('CLI rejects malformed server-issued CSRF tokens without persisting a session', async t => {
  const sessionFile = tempSession(t);
  const client = createClient({
    baseUrl: 'http://127.0.0.1:8080',
    sessionFile,
    fetchImpl: async () => response(200, {
      csrfToken: 'invalid token from response',
      expiresAt: Date.now() + 60000,
      passwordChangeRequired: false
    }, {
      'set-cookie': 'orient_owner_session=' + 't'.repeat(43) + '; Path=/; HttpOnly; SameSite=Strict'
    })
  });

  await assert.rejects(client.login('test-password'), /valid owner session/);
  assert.equal(fs.existsSync(sessionFile), false);
});
