'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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


test('owner auth persists sessions and IP lockouts across service restarts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-auth-'));
  const stateFile = path.join(directory, 'owner-auth-state.json');
  const password = 'a-strong-owner-password-2026';
  try {
    const first = new OwnerAuthService({ password, stateFile, maxFailures: 2, lockoutMs: 10000 });
    const login = await first.login({ password, sourceIp: '192.0.2.50' });
    assert.equal(login.ok, true);
    await first.login({ password: 'wrong', sourceIp: '192.0.2.51' });
    await first.login({ password: 'wrong', sourceIp: '192.0.2.51' });
    assert.equal((fs.statSync(stateFile).mode & 0o777), 0o600);

    const restarted = new OwnerAuthService({ password, stateFile, maxFailures: 2, lockoutMs: 10000 });
    assert.ok(restarted.authenticate(login.token), 'session remains valid after restart');
    assert.equal(
      (await restarted.login({ password, sourceIp: '192.0.2.51' })).code,
      'OWNER_LOGIN_RATE_LIMITED'
    );
    assert.equal(restarted.logout(login.token), true);
    const afterLogout = new OwnerAuthService({ password, stateFile });
    assert.equal(afterLogout.authenticate(login.token), null, 'revocation survives restart');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owner auth fails closed when persisted state is corrupt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-auth-corrupt-'));
  const stateFile = path.join(directory, 'owner-auth-state.json');
  try {
    fs.writeFileSync(stateFile, '{broken', { mode: 0o600 });
    assert.throws(
      () => new OwnerAuthService({ password: 'a-strong-owner-password-2026', stateFile }),
      error => error.code === 'OWNER_AUTH_STATE_CORRUPT'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('owner auth rejects oversized or malformed persisted state before loading entries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-auth-bounds-'));
  const stateFile = path.join(directory, 'owner-auth-state.json');
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      sessions: Array.from({ length: 4097 }, () => ({})),
      failures: []
    }), { mode: 0o600 });
    assert.throws(
      () => new OwnerAuthService({ password: 'a-strong-owner-password-2026', stateFile }),
      error => error.code === 'OWNER_AUTH_STATE_CORRUPT'
    );

    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      sessions: [{
        digest: 'a'.repeat(64),
        id: '00000000-0000-4000-8000-000000000001',
        csrfToken: 'not-a-valid-csrf-token',
        createdAt: 1000,
        expiresAt: 2000
      }],
      failures: []
    }), { mode: 0o600 });
    assert.throws(
      () => new OwnerAuthService({ password: 'a-strong-owner-password-2026', stateFile, now: () => 1500 }),
      error => error.code === 'OWNER_AUTH_STATE_CORRUPT'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owner auth rolls back a newly issued in-memory session when persistence fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-auth-write-failure-'));
  const stateFile = path.join(directory, 'owner-auth-state.json');
  const password = 'a-strong-owner-password-2026';
  try {
    const auth = new OwnerAuthService({ password, stateFile });
    fs.mkdirSync(stateFile);
    await assert.rejects(
      auth.login({ password, sourceIp: '192.0.2.90' }),
      error => error.code === 'OWNER_AUTH_STATE_PERSIST_FAILED'
    );
    assert.equal(auth.sessions.size, 0, 'failed persistence must not leave an unreturned active session');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('owner auth rejects unsafe session and lockout configuration', () => {
  const password = 'a-strong-owner-password-2026';
  assert.throws(() => new OwnerAuthService({ password, sessionTtlMs: 0 }), RangeError);
  assert.throws(() => new OwnerAuthService({ password, sessionTtlMs: 25 * 60 * 60 * 1000 }), RangeError);
  assert.throws(() => new OwnerAuthService({ password, maxFailures: 0 }), RangeError);
  assert.throws(() => new OwnerAuthService({ password, lockoutMs: 0 }), RangeError);
});


test('owner auth rejects persisted sessions beyond configured capacity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-auth-cap-'));
  const stateFile = path.join(directory, 'state.json');
  const session = (digest, id) => ({
    digest: digest.repeat(64),
    id,
    csrfToken: 'A'.repeat(43),
    createdAt: 1000,
    expiresAt: 2000
  });
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      sessions: [
        session('a', '00000000-0000-4000-8000-000000000001'),
        session('b', '00000000-0000-4000-8000-000000000002')
      ],
      failures: []
    }), { mode: 0o600 });
    assert.throws(
      () => new OwnerAuthService({
        password: 'a-strong-owner-password-2026',
        stateFile,
        maxSessions: 1,
        now: () => 1500
      }),
      error => error.code === 'OWNER_AUTH_STATE_CORRUPT'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('owner session validity check rejects missing and expired session identifiers', async () => {
  let now = 1000;
  const password = 'a-strong-owner-password-2026';
  const auth = new OwnerAuthService({ password, sessionTtlMs: 1000, now: () => now });
  assert.equal(auth.isActiveSession(''), false);
  assert.equal(auth.isActiveSession('not-a-session'), false);

  const login = await auth.login({ password, sourceIp: '192.0.2.101' });
  assert.equal(login.ok, true);
  assert.equal(auth.isActiveSession(login.sessionId), true);

  now += 1001;
  assert.equal(auth.isActiveSession(login.sessionId), false);
  assert.equal(auth.sessions.size, 0, 'expired session should be pruned');
});
