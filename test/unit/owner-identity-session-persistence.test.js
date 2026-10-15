'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');

test('owner sessions survive restart without persisting raw tokens and password rotation revokes them', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-session-persistence-'));
  const stateFile = path.join(dataDir, 'owner.json');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const bootstrapPassword = 'temporary-owner-password-9F!x';
  const permanentPassword = 'permanent-owner-password-8Z!';

  const firstProcess = new OwnerIdentityService({ stateFile, bootstrapPassword });
  const firstLogin = await firstProcess.login({ username: 'Admin', password: bootstrapPassword });
  assert.equal(firstLogin.ok, true);
  assert.equal(firstProcess.authenticate(firstLogin.token).csrfToken, firstLogin.csrfToken);

  const persistedBeforeRestart = fs.readFileSync(stateFile, 'utf8');
  assert.equal(persistedBeforeRestart.includes(firstLogin.token), false);
  const storedState = JSON.parse(persistedBeforeRestart);
  assert.match(storedState.sessions[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(storedState.sessions[0].digest, require('node:crypto').createHash('sha256').update(firstLogin.token).digest('hex'));

  // Reconstructing the service models a process restart against the same durable store.
  const afterRestart = new OwnerIdentityService({ stateFile });
  const restoredSession = afterRestart.authenticate(firstLogin.token);
  assert.ok(restoredSession, 'a valid unexpired session should be restored after restart');
  assert.equal(restoredSession.csrfToken, firstLogin.csrfToken);

  const changed = await afterRestart.changePassword({
    token: firstLogin.token,
    password: permanentPassword,
    confirmPassword: permanentPassword
  });
  assert.equal(changed.ok, true);
  assert.equal(afterRestart.authenticate(firstLogin.token), null, 'password rotation must revoke the old session');
  assert.equal((await afterRestart.login({ username: 'Admin', password: bootstrapPassword })).ok, false);

  const permanentLogin = await afterRestart.login({ username: 'Admin', password: permanentPassword });
  assert.equal(permanentLogin.ok, true);
  assert.equal(permanentLogin.passwordChangeRequired, false);
  assert.ok(afterRestart.authenticate(permanentLogin.token));
});
