'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOwnerServer, verifyPassword } = require('../../server');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('owner first-run login forces password replacement and persists only a password hash', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bootstrap = ['temporary', 'owner', 'test', 'password'].join('-');
  const permanent = ['permanent', 'owner', 'test', 'password'].join('-');
  let instance = createOwnerServer({ dataDir, bootstrapPassword: bootstrap, log: () => {} });
  let base = await listen(instance.server);
  t.after(async () => close(instance.server));

  try {
    const status = await fetch(base + '/api/owner/status');
    assert.equal(status.status, 200);
    assert.equal((await status.json()).passwordChangeRequired, true);

    const badLogin = await fetch(base + '/api/owner/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Admin', password: 'wrong-password' })
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(base + '/api/owner/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Admin', password: bootstrap })
    });
    assert.equal(login.status, 200);
    const loginData = await login.json();
    assert.equal(loginData.passwordChangeRequired, true);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const shortPassword = await fetch(base + '/api/owner/password', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ password: 'short', confirmPassword: 'short' })
    });
    assert.equal(shortPassword.status, 400);

    const changed = await fetch(base + '/api/owner/password', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ password: permanent, confirmPassword: permanent })
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).passwordChangeRequired, false);

    const stored = JSON.parse(fs.readFileSync(instance.stateFile, 'utf8'));
    assert.equal(stored.username, 'Admin');
    assert.equal(stored.mustChangePassword, false);
    assert.equal(verifyPassword(permanent, stored.password), true);
    assert.equal(verifyPassword(bootstrap, stored.password), false);
    assert.equal(JSON.stringify(stored).includes(permanent), false);
    assert.equal(JSON.stringify(stored).includes(bootstrap), false);
    assert.equal(fs.statSync(instance.stateFile).mode & 0o777, 0o600);

    await close(instance.server);
    instance = createOwnerServer({ dataDir, log: () => {} });
    base = await listen(instance.server);

    const restartLogin = await fetch(base + '/api/owner/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Admin', password: permanent })
    });
    assert.equal(restartLogin.status, 200);
    assert.equal((await restartLogin.json()).passwordChangeRequired, false);

    const bootstrapRejected = await fetch(base + '/api/owner/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Admin', password: bootstrap })
    });
    assert.equal(bootstrapRejected.status, 401);
  } finally {
    await close(instance.server);
  }
});
