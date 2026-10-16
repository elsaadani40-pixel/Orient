'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, stateFile: path.join(directory, 'owner.json') };
}

test('owner identity bootstrap stores only a password hash and forces rotation', t => {
  const { directory, stateFile } = fixture(t);
  const temporary = 'temporary-owner-password-9F!x';
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: temporary });
  assert.equal(identity.createdBootstrap, true);
  assert.equal(identity.consumeBootstrapPassword(), temporary);
  assert.equal(identity.consumeBootstrapPassword(), null);
  assert.equal(identity.status().passwordChangeRequired, true);
  const persisted = fs.readFileSync(stateFile, 'utf8');
  assert.equal(persisted.includes(temporary), false);
  assert.match(JSON.parse(persisted).passwordHash, /^[a-f0-9]{128}:[a-f0-9]{32}$/);
  assert.equal((fs.statSync(directory).mode & 0o077), 0);
  assert.equal((fs.statSync(stateFile).mode & 0o077), 0, 'owner state file must not be readable by group or others');
});

test('password rotation revokes old owner sessions and returns one replacement session', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const login = await identity.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' });
  assert.equal(login.ok, true);
  const changed = await identity.changePassword({
    token: login.token,
    password: 'permanent-owner-password-2026!',
    confirmPassword: 'permanent-owner-password-2026!'
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.passwordChangeRequired, false);
  assert.equal(identity.authenticate(login.token), null);
  assert.ok(identity.authenticate(changed.token));
  const reloaded = new OwnerIdentityService({ stateFile });
  assert.ok(reloaded.authenticate(changed.token));
  assert.equal((await reloaded.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' })).ok, false);
  assert.equal((await reloaded.login({ username: 'Admin', password: 'permanent-owner-password-2026!' })).ok, true);
});

test('public-user tokens cannot authenticate as owner and owner mutations require CSRF verification', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  assert.equal(identity.authenticate('public-user-session-token-not-an-owner'), null);
  const login = await identity.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' });
  const session = identity.authenticate(login.token);
  assert.ok(session);
  assert.equal(identity.verifyCsrf(session, login.csrfToken), true);
  assert.equal(identity.verifyCsrf(session, 'wrong-token'), false);
  assert.equal(identity.logout(login.token), true);
  assert.equal(identity.authenticate(login.token), null);
});

test('invalid owner state fails closed instead of silently resetting credentials', t => {
  const { stateFile } = fixture(t);
  fs.writeFileSync(stateFile, '{"version":1,"passwordHash":"invalid"}');
  assert.throws(() => new OwnerIdentityService({ stateFile }), { code: 'OWNER_IDENTITY_STATE_INVALID' });
});

test('legacy website owner.json migrates without losing the existing password and forces password rotation', async t => {
  const { stateFile } = fixture(t);
  const legacyPassword = 'legacy-temporary-owner-password-2026!';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(legacyPassword, salt, 64).toString('hex');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    username: 'Admin',
    password: { salt, hash },
    mustChangePassword: true,
    createdAt: new Date(0).toISOString()
  }), { mode: 0o600 });

  const identity = new OwnerIdentityService({ stateFile });
  assert.equal(identity.status().passwordChangeRequired, true);
  const migrated = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(typeof migrated.password, 'undefined');
  assert.match(migrated.passwordHash, /^legacy:[a-f0-9]{128}:[a-f0-9]{32}$/);
  const login = await identity.login({ username: 'Admin', password: legacyPassword });
  assert.equal(login.ok, true);
  assert.equal(login.passwordChangeRequired, true);

  const changed = await identity.changePassword({
    token: login.token,
    password: 'new-permanent-owner-password-2026!',
    confirmPassword: 'new-permanent-owner-password-2026!'
  });
  assert.equal(changed.ok, true);
  assert.match(JSON.parse(fs.readFileSync(stateFile, 'utf8')).passwordHash, /^[a-f0-9]{128}:[a-f0-9]{32}$/);
  assert.equal((await identity.login({ username: 'Admin', password: legacyPassword })).ok, false);
  assert.equal((await identity.login({ username: 'Admin', password: 'new-permanent-owner-password-2026!' })).ok, true);
});

test('owner identity persistence syncs the state file and containing directory', t => {
  const { directory, stateFile } = fixture(t);
  let fileSyncs = 0;
  let directorySyncs = 0;
  const originalFsync = fs.fsyncSync;

  fs.fsyncSync = function (fd) {
    if (fs.fstatSync(fd).isDirectory()) directorySyncs += 1;
    else fileSyncs += 1;
    return originalFsync.call(fs, fd);
  };

  try {
    new OwnerIdentityService({
      stateFile,
      bootstrapPassword: 'temporary-owner-password-9F!x'
    });
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.ok(fileSyncs >= 1, 'state file must be flushed before rename');
  assert.ok(directorySyncs >= 1, 'containing directory must be flushed after rename');
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(directory).filter(name => name.endsWith('.tmp')),
    [],
    'successful persistence must not leave temporary files behind'
  );
});

