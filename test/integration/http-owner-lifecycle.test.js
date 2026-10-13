'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const createServer = require('../../src/interfaces/http/server');
const OwnerAuthService = require('../../src/core/security/owner-auth-service');

const PASSWORD = 'owner-lifecycle-integration-secret-2026';

async function json(response) {
  return response.json();
}

test('owner lifecycle enforces CSRF for cancellation and revokes the session on logout', async t => {
  const calls = [];
  const agentRoutes = {
    async cancel(_req, res, executionId, payload) {
      calls.push({ action: 'cancel', executionId, payload });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, status: 'cancellation_requested' }));
    },
    async pendingApprovals(_req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ approvals: [] }));
    }
  };
  const ownerAuth = new OwnerAuthService({ password: PASSWORD });
  const server = createServer({
    memoryRoutes: { home() {}, add() {}, delete() {} },
    agentRoutes,
    ownerAuth
  });

  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  const unauthenticatedInbox = await fetch(origin + '/owner/approvals');
  assert.equal(unauthenticatedInbox.status, 401);

  const login = await fetch(origin + '/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: PASSWORD })
  });
  assert.equal(login.status, 200);
  const session = await json(login);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.ok(session.csrfToken);

  const inbox = await fetch(origin + '/owner/approvals', { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  assert.deepEqual(await json(inbox), { approvals: [] });

  const noCsrf = await fetch(origin + '/owner/executions/exec-owner-1/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ reason: 'owner_rejected' })
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await json(noCsrf)).code, 'OWNER_CSRF_REJECTED');
  assert.equal(calls.length, 0, 'CSRF-rejected requests must not reach cancellation');

  const cancelled = await fetch(origin + '/owner/executions/exec-owner-1/cancel', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: origin,
      Cookie: cookie,
      'X-ORIENT-CSRF': session.csrfToken
    },
    body: JSON.stringify({ reason: 'owner_rejected' })
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await json(cancelled)).status, 'cancellation_requested');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionId, 'exec-owner-1');

  const logout = await fetch(origin + '/owner/logout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: origin,
      Cookie: cookie,
      'X-ORIENT-CSRF': session.csrfToken
    },
    body: '{}'
  });
  assert.equal(logout.status, 200);

  const afterLogout = await fetch(origin + '/owner/approvals', { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401);
});
