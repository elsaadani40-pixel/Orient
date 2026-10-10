'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OwnerAuthService = require('../../../../src/core/security/owner-auth-service');

test('owner auth denies unconfigured access and rejects weak configured passwords', async () => {
  const unconfigured = new OwnerAuthService({ password: '' });
  assert.deepEqual(await unconfigured.login({ password: 'anything' }), {
    ok: false,
    code: 'OWNER_AUTH_NOT_CONFIGURED'
  });
  assert.throws(
    () => new OwnerAuthService({ password: 'too-short' }),
    error => error.code === 'OWNER_PASSWORD_TOO_WEAK'
  );
});

test('owner auth issues opaque sessions, checks CSRF, and expires sessions', async () => {
  let now = 1000;
  const auth = new OwnerAuthService({
    password: 'a-strong-owner-password-2026',
    sessionTtlMs: 1000,
    now: () => now
  });

  const login = await auth.login({ password: 'a-strong-owner-password-2026', sourceIp: '127.0.0.1' });
  assert.equal(login.ok, true);
  assert.equal(typeof login.token, 'string');
  assert.ok(login.token.length >= 40);
  assert.notEqual(login.token, login.csrfToken);

  const session = auth.authenticate(login.token);
  assert.ok(session);
  assert.equal(auth.verifyCsrf(session, login.csrfToken), true);
  assert.equal(auth.verifyCsrf(session, 'wrong-token'), false);
  assert.equal(auth.logout(login.token), true);
  assert.equal(auth.authenticate(login.token), null);

  const second = await auth.login({ password: 'a-strong-owner-password-2026', sourceIp: '127.0.0.1' });
  now += 1001;
  assert.equal(auth.authenticate(second.token), null);
});

test('owner auth uses bounded per-IP failure lockout and clears it after a successful login', async () => {
  const auth = new OwnerAuthService({
    password: 'a-strong-owner-password-2026',
    maxFailures: 2,
    lockoutMs: 10000
  });

  assert.equal((await auth.login({ password: 'wrong', sourceIp: '192.0.2.1' })).code, 'OWNER_LOGIN_FAILED');
  assert.equal((await auth.login({ password: 'wrong', sourceIp: '192.0.2.1' })).code, 'OWNER_LOGIN_FAILED');
  assert.equal((await auth.login({ password: 'a-strong-owner-password-2026', sourceIp: '192.0.2.1' })).code, 'OWNER_LOGIN_RATE_LIMITED');
  assert.equal((await auth.login({ password: 'a-strong-owner-password-2026', sourceIp: '192.0.2.2' })).ok, true);
});

test('owner auth caps active sessions and prunes expired sessions before rejecting login', async () => {
  let now = 1000;
  const password = 'a-strong-owner-password-2026';
  const auth = new OwnerAuthService({
    password,
    sessionTtlMs: 1000,
    maxSessions: 1,
    now: () => now
  });

  const first = await auth.login({ password, sourceIp: '127.0.0.1' });
  assert.equal(first.ok, true);
  const capped = await auth.login({ password, sourceIp: '127.0.0.2' });
  assert.deepEqual(capped, { ok: false, code: 'OWNER_SESSION_LIMIT_REACHED' });
  assert.equal(auth.sessions.size, 1);

  now += 1001;
  const afterExpiry = await auth.login({ password, sourceIp: '127.0.0.3' });
  assert.equal(afterExpiry.ok, true);
  assert.equal(auth.sessions.size, 1);
  assert.equal(auth.authenticate(first.token), null);
});

test('owner auth rejects invalid session capacity configuration', () => {
  assert.throws(
    () => new OwnerAuthService({ password: 'a-strong-owner-password-2026', maxSessions: 0 }),
    error => error instanceof RangeError
  );
});
