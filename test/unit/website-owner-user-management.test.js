'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOwnerServer } = require('../../server');

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-users-'));
  const { server } = createOwnerServer({
    dataDir,
    bootstrapPassword: 'Temporary-owner-password-12345',
    log: () => {}
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { baseUrl };
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'successful login should set a session cookie');
  return header.split(';', 1)[0];
}

async function postJson(url, body, cookie, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('owner can suspend a user, revoke active sessions, and restore access', async t => {
  const { baseUrl } = await startServer(t);

  const ownerLogin = await postJson(baseUrl + '/api/owner/login', {
    username: 'Admin',
    password: 'Temporary-owner-password-12345'
  }, null, baseUrl);
  assert.equal(ownerLogin.status, 200);
  let ownerCookie = cookieFrom(ownerLogin);

  const passwordChange = await postJson(baseUrl + '/api/owner/password', {
    password: 'Permanent-owner-password-123456',
    confirmPassword: 'Permanent-owner-password-123456'
  }, ownerCookie, baseUrl);
  assert.equal(passwordChange.status, 200);
  ownerCookie = cookieFrom(passwordChange);

  const registration = await postJson(baseUrl + '/api/auth/register', {
    username: 'test-user',
    password: 'User-password-123456'
  }, null, baseUrl);
  assert.equal(registration.status, 201);
  const userCookie = cookieFrom(registration);
  const accountResponse = await fetch(baseUrl + '/api/auth/me', { headers: { Cookie: userCookie } });
  assert.equal(accountResponse.status, 200);

  const usersResponse = await fetch(baseUrl + '/api/owner/users', { headers: { Cookie: ownerCookie } });
  assert.equal(usersResponse.status, 200);
  const usersData = await usersResponse.json();
  const user = usersData.users.find(item => item.username === 'test-user');
  assert.ok(user);

  const rejectedOrigin = await fetch(baseUrl + '/api/owner/users/' + user.id, {
    method: 'PATCH',
    headers: { Cookie: ownerCookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(rejectedOrigin.status, 403);

  const suspend = await fetch(baseUrl + '/api/owner/users/' + user.id, {
    method: 'PATCH',
    headers: { Cookie: ownerCookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(suspend.status, 200);
  assert.equal((await suspend.json()).user.disabled, true);

  const revokedSession = await fetch(baseUrl + '/api/auth/me', { headers: { Cookie: userCookie } });
  assert.equal(revokedSession.status, 401);

  const disabledLogin = await postJson(baseUrl + '/api/auth/login', {
    username: 'test-user',
    password: 'User-password-123456'
  }, null, baseUrl);
  assert.equal(disabledLogin.status, 401);

  const restore = await fetch(baseUrl + '/api/owner/users/' + user.id, {
    method: 'PATCH',
    headers: { Cookie: ownerCookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: false })
  });
  assert.equal(restore.status, 200);
  assert.equal((await restore.json()).user.disabled, false);

  const enabledLogin = await postJson(baseUrl + '/api/auth/login', {
    username: 'test-user',
    password: 'User-password-123456'
  }, null, baseUrl);
  assert.equal(enabledLogin.status, 200);
});
