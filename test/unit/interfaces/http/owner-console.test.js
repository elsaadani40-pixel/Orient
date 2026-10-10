'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createServer = require('../../../../src/interfaces/http/server');
const OwnerAuthService = require('../../../../src/core/security/owner-auth-service');

const PASSWORD = 'correct-horse-battery-staple-2026';

async function withServer(ownerAuth, run, agentRoutes = {}) {
  const auditEvents = [];
  const server = createServer({
    memoryRoutes: {},
    agentRoutes,
    ownerAuth,
    accessAudit: {
      async record(event) { auditEvents.push(event); },
      async listRecent(limit) { return auditEvents.slice(-limit).reverse(); }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = 'http://127.0.0.1:' + address.port;
  try {
    await run({ origin, auditEvents });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function request(origin, pathname, { method = 'GET', headers = {}, body } = {}) {
  return fetch(origin + pathname, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body
  });
}

test('owner console is served with no-store and a restrictive content policy', async () => {
  await withServer(new OwnerAuthService({ password: PASSWORD }), async ({ origin }) => {
    const response = await request(origin, '/owner');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await response.text(), /لوحة تحكم المالك/);
  });
});

test('owner audit endpoint refuses unauthenticated access', async () => {
  await withServer(new OwnerAuthService({ password: PASSWORD }), async ({ origin }) => {
    const response = await request(origin, '/owner/audit');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'OWNER_AUTH_REQUIRED');
  });
});

test('owner login requires same origin and issues an HttpOnly SameSite cookie', async () => {
  await withServer(new OwnerAuthService({ password: PASSWORD }), async ({ origin }) => {
    const rejected = await request(origin, '/owner/login', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD })
    });
    assert.equal(rejected.status, 403);

    const response = await request(origin, '/owner/login', {
      method: 'POST',
      headers: { Origin: origin },
      body: JSON.stringify({ password: PASSWORD })
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /orient_owner_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/); // Local HTTP; production HTTPS sets Secure.
    const payload = await response.json();
    assert.equal(typeof payload.csrfToken, 'string');
    assert.equal(payload.csrfToken.length, 43);
    assert.equal(cookie.includes(payload.csrfToken), false);
  });
});

test('authenticated owner can view audit events; logout enforces CSRF and revokes session', async () => {
  await withServer(new OwnerAuthService({ password: PASSWORD }), async ({ origin, auditEvents }) => {
    const login = await request(origin, '/owner/login', {
      method: 'POST',
      headers: { Origin: origin },
      body: JSON.stringify({ password: PASSWORD })
    });
    assert.equal(login.status, 200);
    const sessionCookie = login.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await login.json();

    const session = await request(origin, '/owner/session', { headers: { Cookie: sessionCookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).csrfToken, csrfToken);

    const audit = await request(origin, '/owner/audit', { headers: { Cookie: sessionCookie } });
    assert.equal(audit.status, 200);
    assert.equal((await audit.json()).ok, true);

    const rejectedLogout = await request(origin, '/owner/logout', {
      method: 'POST',
      headers: { Origin: origin, Cookie: sessionCookie },
      body: '{}'
    });
    assert.equal(rejectedLogout.status, 403);

    const logout = await request(origin, '/owner/logout', {
      method: 'POST',
      headers: { Origin: origin, Cookie: sessionCookie, 'X-ORIENT-CSRF': csrfToken },
      body: '{}'
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

    const afterLogout = await request(origin, '/owner/audit', { headers: { Cookie: sessionCookie } });
    assert.equal(afterLogout.status, 401);
    assert.ok(auditEvents.some(event => event.authenticationOutcome === 'authenticated'));
  });
});

test('owner endpoints fail closed until a password is configured', async () => {
  await withServer(new OwnerAuthService({ password: '' }), async ({ origin }) => {
    const response = await request(origin, '/owner/audit');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'OWNER_AUTH_NOT_CONFIGURED');
  });
});

test('operational dashboard and APIs require the owner session in production composition', async () => {
  await withServer(new OwnerAuthService({ password: PASSWORD }), async ({ origin }) => {
    const deniedDashboard = await request(origin, '/dashboard');
    assert.equal(deniedDashboard.status, 401);
    const deniedAgent = await request(origin, '/agent', {
      method: 'POST',
      body: JSON.stringify({ input: 'must not execute' })
    });
    assert.equal(deniedAgent.status, 401);

    const login = await request(origin, '/owner/login', {
      method: 'POST',
      headers: { Origin: origin },
      body: JSON.stringify({ password: PASSWORD })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const dashboard = await request(origin, '/dashboard', { headers: { Cookie: cookie } });
    assert.equal(dashboard.status, 200);

    const crossOriginMutation = await request(origin, '/agent', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://attacker.example' },
      body: JSON.stringify({ input: 'must not execute' })
    });
    assert.equal(crossOriginMutation.status, 403);
  });
});

test('owner approval inbox is private and approve/cancel actions require CSRF', async () => {
  const approval = {
    approvalId: 'approval-123',
    executionId: 'exec-123',
    step: 1,
    tool: 'project.execute_change',
    capability: 'workspace.write',
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };
  const calls = [];
  const decisionCalls = [];
  const agentRoutes = {
    async recordApprovalDecision(decision) { decisionCalls.push(decision); return { decision: { status: decision.decision } }; },
    async pendingApprovals(_req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify([approval]));
    },
    async resume(_req, res, executionId, body) {
      calls.push({ action: 'resume', executionId, body });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'resumed', executionId, approval: body.approval }));
    },
    async cancel(_req, res, executionId, body) {
      calls.push({ action: 'cancel', executionId, body });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'cancelled', executionId }));
    }
  };

  await withServer(new OwnerAuthService({ password: PASSWORD }), async ({ origin }) => {
    const denied = await request(origin, '/owner/approvals');
    assert.equal(denied.status, 401);

    const login = await request(origin, '/owner/login', {
      method: 'POST',
      headers: { Origin: origin },
      body: JSON.stringify({ password: PASSWORD })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await login.json();

    const inbox = await request(origin, '/owner/approvals?limit=50', {
      headers: { Cookie: cookie }
    });
    assert.equal(inbox.status, 200);
    assert.equal((await inbox.json())[0].approvalId, 'approval-123');

    const csrfDenied = await request(origin, '/owner/executions/exec-123/resume', {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
      body: JSON.stringify({ approval: { approvalId: 'approval-123' } })
    });
    assert.equal(csrfDenied.status, 403);

    const resumed = await request(origin, '/owner/executions/exec-123/resume', {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'X-ORIENT-CSRF': csrfToken },
      body: JSON.stringify({ approval: { approvalId: 'approval-123' }, ignored: 'must not pass through' })
    });
    assert.equal(resumed.status, 200);
    assert.deepEqual((await resumed.json()).approval, { approvalId: 'approval-123' });
    assert.equal(calls[0].action, 'resume');
    assert.deepEqual(calls[0].body, { approval: { approvalId: 'approval-123' } });

    assert.equal(decisionCalls.length, 1);
    assert.equal(decisionCalls[0].decision, 'approved');
    assert.equal(decisionCalls[0].approvalId, 'approval-123');
    assert.equal(decisionCalls[0].executionId, 'exec-123');
    assert.equal(typeof decisionCalls[0].actorId, 'string');

    const cancelled = await request(origin, '/owner/executions/exec-123/cancel', {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'X-ORIENT-CSRF': csrfToken },
      body: JSON.stringify({ reason: 'owner_rejected', approval: { approvalId: 'approval-123' } })
    });
    assert.equal(cancelled.status, 200);
    assert.equal(calls[1].action, 'cancel');
    assert.equal(calls[1].body.reason, 'owner_rejected');
    assert.equal(decisionCalls.length, 2);
    assert.equal(decisionCalls[1].decision, 'rejected');
    assert.equal(decisionCalls[1].executionId, 'exec-123');
  }, agentRoutes);
});
