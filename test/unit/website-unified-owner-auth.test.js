'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');
const OwnerIdentityRuntimeAdapter = require('../../src/core/security/owner-identity-runtime-adapter');
const { createOwnerServer } = require('../../server');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

test('the common sign-in endpoint authenticates the canonical owner email and keeps public users separate', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-unified-owner-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bootstrapPassword = String(crypto.randomInt(1000000000, 9999999999));
  const permanentPassword = crypto.randomBytes(24).toString('base64url') + '!A1';
  const ordinaryUserPassword = crypto.randomBytes(24).toString('base64url') + '!A1';
  const identity = new OwnerIdentityService({
    stateFile: path.join(dataDir, 'owner.json'),
    ownerEmail: ' Elsaadani40@GMAIL.com ',
    bootstrapPassword
  });
  const adapter = new OwnerIdentityRuntimeAdapter({ identity });
  const website = createOwnerServer({ dataDir, identity: adapter, log: () => {} });
  const base = await listen(website.server);
  t.after(() => new Promise(resolve => website.server.close(resolve)));

  const wrongEmail = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ identifier: 'someone@example.com', password: bootstrapPassword })
  });
  assert.equal(wrongEmail.status, 401);

  const wrongOwnerPassword = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ identifier: 'elsaadani40@gmail.com', password: 'wrong-bootstrap-password' })
  });
  assert.equal(wrongOwnerPassword.status, 401);

  const ownerLogin = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ identifier: '  ELSAADANI40@gmail.com ', password: '0123456789' })
  });
  assert.equal(ownerLogin.status, 200);
  const ownerData = await ownerLogin.json();
  assert.equal(ownerData.role, 'owner');
  assert.equal(ownerData.passwordChangeRequired, true);
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];

  const ownerMe = await fetch(base + '/api/auth/me', { headers: { cookie: ownerCookie } });
  assert.equal(ownerMe.status, 200);
  assert.equal((await ownerMe.json()).role, 'owner');

  const ownerPage = await fetch(base + '/account', { headers: { cookie: ownerCookie }, redirect: 'manual' });
  assert.equal(ownerPage.status, 302);
  assert.equal(ownerPage.headers.get('location'), '/account.html');

  const blockedOwnerApi = await fetch(base + '/api/owner/users', { headers: { cookie: ownerCookie } });
  assert.equal(blockedOwnerApi.status, 403, 'owner administration remains blocked until password rotation');

  const rotate = await fetch(base + '/api/owner/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie, origin: base, 'x-orient-csrf': ownerData.csrfToken },
    body: JSON.stringify({
      password: permanentPassword,
      confirmPassword: permanentPassword
    })
  });
  assert.equal(rotate.status, 200);
  const rotatedData = await rotate.json();
  const rotatedCookie = rotate.headers.get('set-cookie').split(';')[0];
  assert.notEqual(rotatedCookie, ownerCookie);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie: ownerCookie } })).status, 401);
  assert.equal((await fetch(base + '/api/owner/users', { headers: { cookie: rotatedCookie } })).status, 200);

  const registered = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'elsaadani40', password: ordinaryUserPassword })
  });
  assert.equal(registered.status, 201);
  const userCookie = registered.headers.get('set-cookie').split(';')[0];
  const userMe = await fetch(base + '/api/auth/me', { headers: { cookie: userCookie } });
  assert.equal(userMe.status, 200);
  assert.equal((await userMe.json()).role, 'user');
  assert.equal((await fetch(base + '/api/owner/users', { headers: { cookie: userCookie } })).status, 401);

  const legacyOwnerPage = await fetch(base + '/dashboard.html', { headers: { cookie: rotatedCookie }, redirect: 'manual' });
  assert.equal(legacyOwnerPage.status, 200);
  assert.match(await legacyOwnerPage.text(), /لوحة تحكم المالك/);
});
