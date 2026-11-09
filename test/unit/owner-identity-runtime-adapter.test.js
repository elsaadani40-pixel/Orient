'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');
const OwnerIdentityRuntimeAdapter = require('../../src/core/security/owner-identity-runtime-adapter');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-runtime-adapter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, stateFile: path.join(directory, 'owner.json') };
}

test('Runtime adapter exposes only the shared owner identity authority', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const adapter = new OwnerIdentityRuntimeAdapter({ identity });
  assert.equal(adapter.enabled, true);
  const login = await adapter.login({ password: 'temporary-owner-password-9F!x', sourceIp: '127.0.0.1' });
  assert.equal(login.ok, true);
  const session = adapter.authenticate(login.token);
  assert.ok(session);
  assert.equal(adapter.verifyCsrf(session, login.csrfToken), true);
  assert.equal(adapter.verifyCsrf(session, 'invalid'), false);
  assert.equal(adapter.isActiveSession(session.sessionId), true);
  assert.equal(adapter.logout(login.token), true);
  assert.equal(adapter.isActiveSession(session.sessionId), false);
  assert.equal(adapter.authenticate(login.token), null);
});

test('Runtime adapter rate-limits failed owner logins per source IP', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  let now = 100000;
  const adapter = new OwnerIdentityRuntimeAdapter({ identity, maxFailures: 2, lockoutMs: 60000, now: () => now });
  assert.equal((await adapter.login({ password: 'wrong', sourceIp: '192.0.2.10' })).code, 'OWNER_LOGIN_FAILED');
  assert.equal((await adapter.login({ password: 'wrong', sourceIp: '192.0.2.10' })).code, 'OWNER_LOGIN_FAILED');
  assert.equal((await adapter.login({ password: 'temporary-owner-password-9F!x', sourceIp: '192.0.2.10' })).code, 'OWNER_LOGIN_RATE_LIMITED');
  assert.equal((await adapter.login({ password: 'wrong', sourceIp: '192.0.2.11' })).code, 'OWNER_LOGIN_FAILED');
  now += 60001;
  assert.equal((await adapter.login({ password: 'temporary-owner-password-9F!x', sourceIp: '192.0.2.10' })).ok, true);
});

test('Runtime adapter password rotation invalidates the old session and returns a replacement', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const adapter = new OwnerIdentityRuntimeAdapter({ identity });
  const login = await adapter.login({ password: 'temporary-owner-password-9F!x', sourceIp: '127.0.0.1' });
  assert.equal(login.ok, true);
  const rotated = await adapter.changePassword({
    token: login.token,
    password: 'a-new-strong-owner-password-8Z!',
    confirmPassword: 'a-new-strong-owner-password-8Z!'
  });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.passwordChangeRequired, false);
  assert.equal(adapter.authenticate(login.token), null);
  assert.ok(adapter.authenticate(rotated.token));
  assert.equal((await adapter.login({ password: 'temporary-owner-password-9F!x' })).ok, false);
  assert.equal((await adapter.login({ password: 'a-new-strong-owner-password-8Z!' })).ok, true);
});

test('Runtime adapter never accepts a public-user token as an owner session', t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const adapter = new OwnerIdentityRuntimeAdapter({ identity });
  const publicUserToken = require('node:crypto').randomBytes(32).toString('base64url');
  assert.equal(adapter.authenticate(publicUserToken), null);
  assert.equal(adapter.logout(publicUserToken), false);
});

test('Runtime adapter rejects an incompatible identity service at construction', () => {
  assert.throws(() => new OwnerIdentityRuntimeAdapter({ identity: {} }), /compatible OwnerIdentityService/);
});

test('owner lockout digests use an independent persistent key and survive restart', async t => {
  const { stateFile } = fixture(t);
  const bootstrapPassword = 'temporary-owner-password-9F!x';
  const sourceIp = '192.0.2.44';
  let now = 100000;
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword, now: () => now });
  const adapter = new OwnerIdentityRuntimeAdapter({
    identity, maxFailures: 2, lockoutMs: 60000, now: () => now
  });

  assert.equal((await adapter.login({ password: 'wrong', sourceIp })).code, 'OWNER_LOGIN_FAILED');
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const keyFile = stateFile + '.lockout-key';
  const encodedKey = fs.readFileSync(keyFile, 'utf8');
  assert.match(encodedKey, /^[a-f0-9]{64}$/);
  assert.equal(persisted.loginFailures[0].keyVersion, 2);
  assert.equal(
    persisted.loginFailures[0].key,
    crypto.createHmac('sha256', Buffer.from(encodedKey, 'hex')).update(sourceIp).digest('hex')
  );
  assert.notEqual(
    persisted.loginFailures[0].key,
    crypto.createHmac('sha256', persisted.passwordHash).update(sourceIp).digest('hex'),
    'the password verifier must not be reused as the lockout HMAC key'
  );
  assert.equal(JSON.stringify(persisted).includes(sourceIp), false, 'raw source IP must not be persisted');
  assert.equal(JSON.stringify(persisted).includes(encodedKey), false, 'the independent key must not be stored in owner.json');
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);

  const restartedIdentity = new OwnerIdentityService({ stateFile, now: () => now });
  const restartedAdapter = new OwnerIdentityRuntimeAdapter({
    identity: restartedIdentity, maxFailures: 2, lockoutMs: 60000, now: () => now
  });
  assert.equal((await restartedAdapter.login({ password: 'wrong', sourceIp })).code, 'OWNER_LOGIN_FAILED');
  assert.equal(
    (await restartedAdapter.login({ password: bootstrapPassword, sourceIp })).code,
    'OWNER_LOGIN_RATE_LIMITED',
    'the independent key must preserve the source lockout across restart'
  );
});

test('owner identity fails closed when its independent lockout key is lost with active v2 records', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const adapter = new OwnerIdentityRuntimeAdapter({ identity, maxFailures: 2 });
  assert.equal((await adapter.login({ password: 'wrong', sourceIp: '192.0.2.45' })).code, 'OWNER_LOGIN_FAILED');

  fs.unlinkSync(stateFile + '.lockout-key');
  assert.throws(
    () => new OwnerIdentityService({ stateFile }),
    { code: 'OWNER_LOCKOUT_KEY_UNAVAILABLE' },
    'a missing key must not silently discard active lockout records'
  );
});

test('legacy verifier-keyed lockout records remain enforced during key separation migration', async t => {
  const { stateFile } = fixture(t);
  const bootstrapPassword = 'temporary-owner-password-9F!x';
  const sourceIp = '192.0.2.46';
  const now = 200000;
  new OwnerIdentityService({ stateFile, bootstrapPassword, now: () => now });
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const legacyKey = crypto.createHmac('sha256', persisted.passwordHash).update(sourceIp).digest('hex');
  persisted.loginFailures = [{
    key: legacyKey,
    count: 1,
    windowStartedAt: now,
    blockedUntil: 0
  }];
  fs.writeFileSync(stateFile, JSON.stringify(persisted) + '\n', { mode: 0o600 });

  const migratedIdentity = new OwnerIdentityService({ stateFile, now: () => now });
  const adapter = new OwnerIdentityRuntimeAdapter({
    identity: migratedIdentity, maxFailures: 2, lockoutMs: 60000, now: () => now
  });
  assert.equal((await adapter.login({ password: 'wrong', sourceIp })).code, 'OWNER_LOGIN_FAILED');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).loginFailures[0].keyVersion, 1);
  assert.equal(
    (await adapter.login({ password: bootstrapPassword, sourceIp })).code,
    'OWNER_LOGIN_RATE_LIMITED',
    'legacy lockout state must remain effective until its window expires'
  );
});


test('owner lockout key rejects symbolic links at open time', t => {
  if (process.platform === 'win32' || typeof fs.constants.O_NOFOLLOW !== 'number') {
    t.skip('the platform does not expose POSIX O_NOFOLLOW through Node');
    return;
  }

  const { directory, stateFile } = fixture(t);
  const targetFile = path.join(directory, 'attacker-controlled-target');
  const keyFile = stateFile + '.lockout-key';
  fs.writeFileSync(targetFile, 'a'.repeat(64), { mode: 0o600 });
  fs.symlinkSync(targetFile, keyFile);

  assert.throws(
    () => new OwnerIdentityService({
      stateFile,
      bootstrapPassword: 'temporary-owner-password-9F!x'
    }),
    { code: 'OWNER_LOCKOUT_KEY_INVALID' }
  );
  assert.equal(fs.readFileSync(targetFile, 'utf8'), 'a'.repeat(64));
});

test('concurrent failed owner logins enforce the configured threshold without exceeding the failure store', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const adapter = new OwnerIdentityRuntimeAdapter({ identity, maxFailures: 3, lockoutMs: 60000 });
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    adapter.login({ password: 'wrong', sourceIp: '192.0.2.47' })
  ));
  assert.equal(results.filter(result => result.code === 'OWNER_LOGIN_FAILED').length, 3);
  assert.equal(results.filter(result => result.code === 'OWNER_LOGIN_RATE_LIMITED').length, 5);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).loginFailures.length, 1);
});

