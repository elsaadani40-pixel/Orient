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


test('owner auth verifies session identity only while that session is active', async () => {
  let now = 1000;
  const password = 'a-strong-owner-password-2026';
  const auth = new OwnerAuthService({ password, sessionTtlMs: 1000, now: () => now });

  const first = await auth.login({ password, sourceIp: '192.0.2.101' });
  const second = await auth.login({ password, sourceIp: '192.0.2.102' });
  assert.equal(auth.isActiveSession(first.sessionId), true);
  assert.equal(auth.isActiveSession(second.sessionId), true);
  assert.equal(auth.isActiveSession(''), false);
  assert.equal(auth.isActiveSession('unknown-session-id'), false);

  assert.equal(auth.logout(first.token), true);
  assert.equal(auth.isActiveSession(first.sessionId), false, 'logged-out session identity is no longer active');
  assert.equal(auth.isActiveSession(second.sessionId), true, 'revoking one session does not revoke another');

  now += 1000;
  assert.equal(auth.isActiveSession(second.sessionId), false, 'session expires at its expiry boundary');
  assert.equal(auth.sessions.size, 0, 'expired sessions are pruned');
});


test('owner auth rejects malformed and duplicate persisted IP failure records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-auth-failure-state-'));
  const stateFile = path.join(directory, 'state.json');
  const password = 'a-strong-owner-password-2026';
  const validFailure = {
    ip: '192.0.2.200',
    count: 1,
    windowStartedAt: 1000,
    blockedUntil: 0
  };
  const invalidCases = [
    { name: 'empty IP', failures: [{ ...validFailure, ip: '' }] },
    { name: 'oversized IP', failures: [{ ...validFailure, ip: 'x'.repeat(65) }] },
    { name: 'zero failure count', failures: [{ ...validFailure, count: 0 }] },
    { name: 'excessive failure count', failures: [{ ...validFailure, count: 100001 }] },
    { name: 'future window start', failures: [{ ...validFailure, windowStartedAt: 1501 }] },
    { name: 'negative window start', failures: [{ ...validFailure, windowStartedAt: -1 }] },
    { name: 'negative block expiry', failures: [{ ...validFailure, blockedUntil: -1 }] },
    { name: 'block expiry beyond lockout horizon', failures: [{ ...validFailure, blockedUntil: 11501 }] },
    { name: 'duplicate IP entries', failures: [validFailure, { ...validFailure, count: 2 }] }
  ];

  try {
    for (const scenario of invalidCases) {
      fs.writeFileSync(stateFile, JSON.stringify({
        version: 1,
        sessions: [],
        failures: scenario.failures
      }), { mode: 0o600 });

      assert.throws(
        () => new OwnerAuthService({
          password,
          stateFile,
          lockoutMs: 10000,
          now: () => 1500
        }),
        error => error.code === 'OWNER_AUTH_STATE_CORRUPT',
        scenario.name
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('owner lockout expires exactly at blockedUntil', async () => {
  let now = 1000;
  const password = 'a-strong-owner-password-2026';
  const auth = new OwnerAuthService({
    password,
    maxFailures: 1,
    lockoutMs: 5000,
    now: () => now
  });

  assert.equal((await auth.login({ password: 'wrong', sourceIp: '192.0.2.210' })).code, 'OWNER_LOGIN_FAILED');
  assert.equal(auth.failures.get('192.0.2.210').blockedUntil, 6000);
  now = 6000;
  assert.equal((await auth.login({ password, sourceIp: '192.0.2.210' })).ok, true);
});

test('owner failure window resets at the exact lockout-window boundary', async () => {
  let now = 1000;
  const password = 'a-strong-owner-password-2026';
  const auth = new OwnerAuthService({
    password,
    maxFailures: 2,
    lockoutMs: 5000,
    now: () => now
  });

  assert.equal((await auth.login({ password: 'wrong', sourceIp: '192.0.2.211' })).code, 'OWNER_LOGIN_FAILED');
  now = 6000;
  assert.equal((await auth.login({ password: 'wrong', sourceIp: '192.0.2.211' })).code, 'OWNER_LOGIN_FAILED');
  assert.equal(auth.failures.get('192.0.2.211').count, 1);
  assert.equal((await auth.login({ password, sourceIp: '192.0.2.211' })).ok, true);
});

test('owner auth bounds the in-memory IP failure map and evicts the oldest entry', () => {
  const auth = new OwnerAuthService({ password: 'a-strong-owner-password-2026' });
  for (let index = 0; index < 1025; index += 1) {
    auth.recordFailure(`192.0.2.${index}`, 1000 + index);
  }
  assert.equal(auth.failures.size, 1024);
  assert.equal(auth.failures.has('192.0.2.0'), false);
  assert.equal(auth.failures.has('192.0.2.1024'), true);
});

test('owner auth rejects each malformed persisted session identity and timestamp field', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-auth-session-validation-'));
  const stateFile = path.join(directory, 'state.json');
  const password = 'a-strong-owner-password-2026';
  const validSession = {
    digest: 'a'.repeat(64),
    id: '00000000-0000-4000-8000-000000000001',
    csrfToken: 'A'.repeat(43),
    createdAt: 1000,
    expiresAt: 2000
  };
  const invalidSessions = [
    { name: 'invalid digest alphabet', session: { ...validSession, digest: 'g'.repeat(64) } },
    { name: 'invalid session UUID', session: { ...validSession, id: 'not-a-uuid' } },
    { name: 'empty CSRF token', session: { ...validSession, csrfToken: '' } },
    { name: 'negative creation time', session: { ...validSession, createdAt: -1 } },
    { name: 'future creation time', session: { ...validSession, createdAt: 1501 } },
    { name: 'expiry before creation', session: { ...validSession, expiresAt: 999 } },
    { name: 'expiry exceeds session TTL', session: { ...validSession, expiresAt: 2001 } },
    { name: 'duplicate session digest', sessions: [validSession, { ...validSession, id: '00000000-0000-4000-8000-000000000002' }] }
  ];

  try {
    for (const scenario of invalidSessions) {
      fs.writeFileSync(stateFile, JSON.stringify({
        version: 1,
        sessions: scenario.sessions || [scenario.session],
        failures: []
      }), { mode: 0o600 });
      assert.throws(
        () => new OwnerAuthService({ password, stateFile, sessionTtlMs: 1000, now: () => 1500 }),
        error => error.code === 'OWNER_AUTH_STATE_CORRUPT',
        scenario.name
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owner auth accepts persisted IP failure records at both supported length boundaries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-auth-ip-boundaries-'));
  const stateFile = path.join(directory, 'state.json');
  const validFailure = (ip) => ({ ip, count: 1, windowStartedAt: 1000, blockedUntil: 0 });
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      sessions: [],
      failures: [validFailure('x'), validFailure('y'.repeat(64))]
    }), { mode: 0o600 });
    const auth = new OwnerAuthService({
      password: 'a-strong-owner-password-2026',
      stateFile,
      now: () => 1500
    });
    assert.equal(auth.failures.size, 2);
    assert.equal(auth.failures.has('x'), true);
    assert.equal(auth.failures.has('y'.repeat(64)), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owner login rejects non-string and oversized password candidates', async () => {
  const auth = new OwnerAuthService({ password: 'a-strong-owner-password-2026' });
  assert.equal((await auth.login({ password: 42, sourceIp: '192.0.2.220' })).code, 'OWNER_LOGIN_FAILED');
  assert.equal((await auth.login({ password: 'x'.repeat(1025), sourceIp: '192.0.2.221' })).code, 'OWNER_LOGIN_FAILED');
});
