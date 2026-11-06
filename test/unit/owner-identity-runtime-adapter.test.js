'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');
const OwnerIdentityRuntimeAdapter = require('../../src/core/security/owner-identity-runtime-adapter');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-runtime-adapter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { stateFile: path.join(directory, 'owner.json') };
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

test('authenticated owner sessions resolve to a stable trusted principal', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const adapter = new OwnerIdentityRuntimeAdapter({ identity, tenantId: 'tenant-local', workspaceId: 'workspace-main' });
  const login = await adapter.login({ password: 'temporary-owner-password-9F!x' });
  const session = adapter.authenticate(login.token);
  assert.ok(session);
  assert.deepEqual(session.principal, {
    principalId: identity.state.ownerId,
    ownerId: identity.state.ownerId,
    tenantId: 'tenant-local',
    workspaceId: 'workspace-main',
    authSource: 'orient-owner-session',
    sessionId: session.sessionId
  });
  assert.equal(Object.isFrozen(session.principal), true);
  assert.equal(adapter.authenticate(require('node:crypto').randomBytes(32).toString('base64url')), null);
  const restarted = new OwnerIdentityService({ stateFile });
  const reloadedAdapter = new OwnerIdentityRuntimeAdapter({ identity: restarted, tenantId: 'tenant-local', workspaceId: 'workspace-main' });
  assert.equal(reloadedAdapter.authenticate(login.token).principal.ownerId, session.principal.ownerId);
});

test('owner identity receives a persistent UUID and legacy state is upgraded once', t => {
  const { stateFile } = fixture(t);
  const first = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const ownerId = first.state.ownerId;
  assert.equal(Object.hasOwn(first.status(), 'ownerId'), false, 'public status must not disclose the stable owner identifier');
  assert.match(ownerId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const second = new OwnerIdentityService({ stateFile });
  assert.equal(second.state.ownerId, ownerId);
});

test('runtime principal scope rejects invalid tenant and workspace configuration', t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  assert.throws(() => new OwnerIdentityRuntimeAdapter({ identity, tenantId: '' }), /tenantId/);
  assert.throws(() => new OwnerIdentityRuntimeAdapter({ identity, workspaceId: 'x'.repeat(129) }), /workspaceId/);
});

test('runtime composition receives a stable internal owner principal distinct from login sessions', t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const adapter = new OwnerIdentityRuntimeAdapter({ identity, tenantId: 'tenant-runtime', workspaceId: 'workspace-runtime' });
  const first = adapter.createRuntimePrincipal();
  const second = adapter.createRuntimePrincipal();
  assert.equal(first.ownerId, identity.getStableOwnerIdForRuntime());
  assert.equal(first.principalId, first.ownerId);
  assert.equal(first.tenantId, 'tenant-runtime');
  assert.equal(first.workspaceId, 'workspace-runtime');
  assert.equal(first.authSource, 'orient-runtime-owner');
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.hasOwn(adapter.status(), 'ownerId'), false);
});
