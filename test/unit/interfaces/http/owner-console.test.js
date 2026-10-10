'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createServer = require('../../../../src/interfaces/http/server');
const OwnerAuthService = require('../../../../src/core/security/owner-auth-service');

const PASSWORD = 'correct-horse-battery-staple-2026';

async function withServer(ownerAuth, run) {
  const auditEvents = [];
  const server = createServer({
    memoryRoutes: {},
    agentRoutes: {},
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
    assert.match(cookie, /Path=\/owner/);
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
