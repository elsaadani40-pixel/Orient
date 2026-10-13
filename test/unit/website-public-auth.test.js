'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOwnerServer } = require('../../server');

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

test('public registration creates a regular account and never grants owner dashboard access', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-public-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const instance = createOwnerServer({ dataDir, bootstrapPassword: 'temporary-owner-password-9F!x', log: () => {} });
  assert.equal(typeof instance.handler, 'function', 'website routes must be exposable for single-server composition');
  assert.equal(instance.server.listeners('request')[0], instance.handler, 'standalone and composed modes must use the exact same request handler');
  const base = await listen(instance.server);
  t.after(() => close(instance.server));

  for (const protectedPath of ['/dashboard.html', '/owner.html', '/owner']) {
    const blocked = await fetch(base + protectedPath, { redirect: 'manual' });
    assert.equal(blocked.status, 302, protectedPath + ' must require owner authentication');
    assert.equal(blocked.headers.get('location'), '/auth?mode=owner');
  }

  const registered = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'public_user', password: 'long-public-password-123' })
  });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).role, 'user');
  const cookie = registered.headers.get('set-cookie').split(';')[0];

  const accountRoute = await fetch(base + '/account', { headers: { cookie }, redirect: 'manual' });
  assert.equal(accountRoute.status, 302);
  assert.equal(accountRoute.headers.get('location'), '/account.html');
  const accountPage = await fetch(base + '/account.html', { headers: { cookie }, redirect: 'manual' });
  assert.equal(accountPage.status, 200);
  assert.match(await accountPage.text(), /PERSONAL ACCOUNT/);

  const ownerApi = await fetch(base + '/api/owner/users', { headers: { cookie } });
  assert.equal(ownerApi.status, 401);
  const dashboard = await fetch(base + '/dashboard.html', { headers: { cookie }, redirect: 'manual' });
  assert.equal(dashboard.status, 302);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].role, 'user');
  assert.equal(JSON.stringify(stored).includes('long-public-password-123'), false);
  assert.equal(fs.statSync(path.join(dataDir, 'users.json')).mode & 0o777, 0o600);

  const logout = await fetch(base + '/api/auth/logout', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: '{}'
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(base + '/account.html', { redirect: 'manual' });
  assert.equal(afterLogout.status, 302);
  assert.equal(afterLogout.headers.get('location'), '/auth');
});

test('owner alone can open the dashboard after mandatory password replacement', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-dashboard-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const instance = createOwnerServer({ dataDir, bootstrapPassword: 'temporary-owner-password-9F!x', log: () => {} });
  const base = await listen(instance.server);
  t.after(() => close(instance.server));

  const login = await fetch(base + '/api/owner/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Admin', password: 'temporary-owner-password-9F!x' })
  });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const secondLogin = await fetch(base + '/api/owner/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Admin', password: 'temporary-owner-password-9F!x' })
  });
  assert.equal(secondLogin.status, 200);
  const staleCookie = secondLogin.headers.get('set-cookie').split(';')[0];

  for (const protectedPath of ['/owner', '/dashboard.html']) {
    const beforeChange = await fetch(base + protectedPath, { headers: { cookie }, redirect: 'manual' });
    assert.equal(beforeChange.status, 302);
    assert.equal(beforeChange.headers.get('location'), '/owner.html');
  }
  const setupPage = await fetch(base + '/owner.html', { headers: { cookie }, redirect: 'manual' });
  assert.equal(setupPage.status, 200);

  const changed = await fetch(base + '/api/owner/password', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'permanent-owner-password-2026!', confirmPassword: 'permanent-owner-password-2026!' })
  });
  assert.equal(changed.status, 200);
  const oldCookie = cookie;
  cookie = changed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie, oldCookie, 'password rotation must issue a fresh owner session');
  assert.equal((await fetch(base + '/api/owner/me', { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await fetch(base + '/api/owner/me', { headers: { cookie: staleCookie } })).status, 401);
  assert.equal((await fetch(base + '/api/owner/me', { headers: { cookie } })).status, 200);

  for (const protectedPath of ['/owner', '/owner.html']) {
    const dashboard = await fetch(base + protectedPath, { headers: { cookie }, redirect: 'manual' });
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.headers.get('location'), '/dashboard.html');
  }

  const html = await fetch(base + '/dashboard.html', { headers: { cookie }, redirect: 'manual' });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /لوحة تحكم المالك/);

  const users = await fetch(base + '/api/owner/users', { headers: { cookie } });
  assert.equal(users.status, 200);
  assert.equal((await users.json()).count, 0);
});

test('owner can disable and re-enable a public account, and disabling revokes its active session', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-account-controls-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const instance = createOwnerServer({ dataDir, bootstrapPassword: 'temporary-owner-password-9F!x', log: () => {} });
  const base = await listen(instance.server);
  t.after(() => close(instance.server));

  const registered = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'managed_user', password: 'long-public-password-123' })
  });
  assert.equal(registered.status, 201);
  const userCookie = registered.headers.get('set-cookie').split(';')[0];
  const userId = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'))[0].id;

  const denied = await fetch(base + '/api/owner/users/' + userId + '/status', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: userCookie },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(denied.status, 401);

  const ownerLogin = await fetch(base + '/api/owner/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Admin', password: 'temporary-owner-password-9F!x' })
  });
  let ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
  const passwordChange = await fetch(base + '/api/owner/password', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ password: 'permanent-owner-password-2026!', confirmPassword: 'permanent-owner-password-2026!' })
  });
  assert.equal(passwordChange.status, 200);
  ownerCookie = passwordChange.headers.get('set-cookie').split(';')[0];

  const disable = await fetch(base + '/api/owner/users/' + userId + '/status', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(disable.status, 200);
  assert.equal((await disable.json()).disabled, true);
  const revoked = await fetch(base + '/api/auth/me', { headers: { cookie: userCookie } });
  assert.equal(revoked.status, 401);

  const enable = await fetch(base + '/api/owner/users/' + userId + '/status', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ disabled: false })
  });
  assert.equal(enable.status, 200);
  assert.equal((await enable.json()).disabled, false);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  assert.equal(stored[0].disabled, false);
});

test('a public user can change their password, rotate the active session, and no longer use the old password', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-user-password-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const instance = createOwnerServer({ dataDir, bootstrapPassword: 'temporary-owner-password-9F!x', log: () => {} });
  const base = await listen(instance.server);
  t.after(() => close(instance.server));
  const oldPassword = 'original-public-password-123';
  const newPassword = 'replacement-public-password-456';
  const registered = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'password_user', password: oldPassword })
  });
  assert.equal(registered.status, 201);
  const oldCookie = registered.headers.get('set-cookie').split(';')[0];

  const badChange = await fetch(base + '/api/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: oldCookie },
    body: JSON.stringify({ currentPassword: 'wrong-current-password', password: newPassword, confirmPassword: newPassword })
  });
  assert.equal(badChange.status, 401);

  const changed = await fetch(base + '/api/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: oldCookie },
    body: JSON.stringify({ currentPassword: oldPassword, password: newPassword, confirmPassword: newPassword })
  });
  assert.equal(changed.status, 200);
  const newCookie = changed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(newCookie, oldCookie);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie: newCookie } })).status, 200);

  const oldLogin = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'password_user', password: oldPassword })
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'password_user', password: newPassword })
  });
  assert.equal(newLogin.status, 200);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  assert.equal(JSON.stringify(stored).includes(newPassword), false);
});
