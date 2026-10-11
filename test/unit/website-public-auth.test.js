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
  const base = await listen(instance.server);
  t.after(() => close(instance.server));

  const blocked = await fetch(base + '/dashboard.html', { redirect: 'manual' });
  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get('location'), '/auth?mode=owner');

  const registered = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'public_user', password: 'long-public-password-123' })
  });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).role, 'user');
  const cookie = registered.headers.get('set-cookie').split(';')[0];

  const ownerApi = await fetch(base + '/api/owner/users', { headers: { cookie } });
  assert.equal(ownerApi.status, 401);
  const dashboard = await fetch(base + '/dashboard.html', { headers: { cookie }, redirect: 'manual' });
  assert.equal(dashboard.status, 302);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].role, 'user');
  assert.equal(JSON.stringify(stored).includes('long-public-password-123'), false);
  assert.equal(fs.statSync(path.join(dataDir, 'users.json')).mode & 0o777, 0o600);
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
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const beforeChange = await fetch(base + '/owner', { headers: { cookie }, redirect: 'manual' });
  assert.equal(beforeChange.status, 302);
  assert.equal(beforeChange.headers.get('location'), '/owner.html');

  const changed = await fetch(base + '/api/owner/password', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'permanent-owner-password-2026!', confirmPassword: 'permanent-owner-password-2026!' })
  });
  assert.equal(changed.status, 200);

  const dashboard = await fetch(base + '/owner', { headers: { cookie }, redirect: 'manual' });
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.get('location'), '/dashboard.html');

  const html = await fetch(base + '/dashboard.html', { headers: { cookie }, redirect: 'manual' });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /لوحة تحكم المالك/);

  const users = await fetch(base + '/api/owner/users', { headers: { cookie } });
  assert.equal(users.status, 200);
  assert.equal((await users.json()).count, 0);
});
