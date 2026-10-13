'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOwnerServer } = require('../../server');

const BOOTSTRAP_CREDENTIAL = ['temporary', 'owner', 'test', 'password'].join('-');
const ROTATED_CREDENTIAL = ['permanent', 'owner', 'test', 'password'].join('-');
const PUBLIC_CREDENTIAL = ['public', 'user', 'test', 'password'].join('-');

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-users-'));
  const { server } = createOwnerServer({
    dataDir,
    bootstrapPassword: BOOTSTRAP_CREDENTIAL,
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
  assert.ok(header, 'successful authentication should set a session cookie');
  return header.split(';', 1)[0];
}

async function postJson(url, body, cookie, origin, csrfToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (csrfToken) headers['x-orient-csrf'] = csrfToken;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('owner can suspend a user, revoke active sessions, and restore access', async t => {
  const { baseUrl } = await startServer(t);

  const ownerLogin = await postJson(baseUrl + '/api/owner/login', {
    username: 'Admin',
    password: BOOTSTRAP_CREDENTIAL
  }, null, baseUrl);
  assert.equal(ownerLogin.status, 200);
  const ownerLoginData = await ownerLogin.json();
  let ownerCookie = cookieFrom(ownerLogin);
  let ownerCsrf = ownerLoginData.csrfToken;

  const passwordChange = await postJson(baseUrl + '/api/owner/password', {
    password: ROTATED_CREDENTIAL,
    confirmPassword: ROTATED_CREDENTIAL
  }, ownerCookie, baseUrl, ownerCsrf);
  assert.equal(passwordChange.status, 200);
  const passwordChangeData = await passwordChange.json();
  ownerCookie = cookieFrom(passwordChange);
  ownerCsrf = passwordChangeData.csrfToken;

  const registration = await postJson(baseUrl + '/api/auth/register', {
    username: 'test-user',
    password: PUBLIC_CREDENTIAL
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
    headers: { Cookie: ownerCookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json', 'x-orient-csrf': ownerCsrf },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(rejectedOrigin.status, 403);

  const suspend = await fetch(baseUrl + '/api/owner/users/' + user.id, {
    method: 'PATCH',
    headers: { Cookie: ownerCookie, Origin: baseUrl, 'Content-Type': 'application/json', 'x-orient-csrf': ownerCsrf },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(suspend.status, 200);
  assert.equal((await suspend.json()).user.disabled, true);

  const revokedSession = await fetch(baseUrl + '/api/auth/me', { headers: { Cookie: userCookie } });
  assert.equal(revokedSession.status, 401);

  const disabledLogin = await postJson(baseUrl + '/api/auth/login', {
    username: 'test-user',
    password: PUBLIC_CREDENTIAL
  }, null, baseUrl);
  assert.equal(disabledLogin.status, 401);

  const restore = await fetch(baseUrl + '/api/owner/users/' + user.id, {
    method: 'PATCH',
    headers: { Cookie: ownerCookie, Origin: baseUrl, 'Content-Type': 'application/json', 'x-orient-csrf': ownerCsrf },
    body: JSON.stringify({ disabled: false })
  });
  assert.equal(restore.status, 200);
  assert.equal((await restore.json()).user.disabled, false);

  const enabledLogin = await postJson(baseUrl + '/api/auth/login', {
    username: 'test-user',
    password: PUBLIC_CREDENTIAL
  }, null, baseUrl);
  assert.equal(enabledLogin.status, 200);
});
