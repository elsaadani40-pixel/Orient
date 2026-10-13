'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');
const OwnerIdentityRuntimeAdapter = require('../../src/core/security/owner-identity-runtime-adapter');
const { createOwnerServer } = require('../../server');
const createRuntimeServer = require('../../src/interfaces/http/server');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
}
function cookie(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'expected an HttpOnly session cookie');
  return value.split(';')[0];
}

test('website and Runtime share one owner identity, force rotation, and reject public-user sessions', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-unified-owner-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bootstrapPassword = 'temporary-owner-password-9F!x';
  const permanentPassword = 'a-new-strong-owner-password-8Z!';
  const identity = new OwnerIdentityService({
    stateFile: path.join(dataDir, 'owner.json'),
    bootstrapPassword
  });
  const ownerAuth = new OwnerIdentityRuntimeAdapter({ identity });
  const website = createOwnerServer({ dataDir, identity: ownerAuth, log: () => {} });
  const agentRoutes = {
    async tasks(_req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, tasks: [] }));
    }
  };
  const runtime = createRuntimeServer({
    memoryRoutes: { home(_req, res) { res.writeHead(200); res.end('home'); } },
    agentRoutes,
    ownerAuth,
    websiteHandler: website.handler
  });
  const base = await listen(runtime);
  t.after(async () => { await close(runtime); await close(website.server); });

  assert.equal(website.server.listening, false, 'website must not start a second listener');

  const status = await fetch(base + '/api/owner/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).passwordChangeRequired, true);

  const login = await fetch(base + '/api/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'Admin', password: bootstrapPassword })
  });
  assert.equal(login.status, 200);
  const loginData = await login.json();
  assert.equal(loginData.passwordChangeRequired, true);
  let ownerCookie = cookie(login);

  const blockedTaskRead = await fetch(base + '/api/v1/tasks', { headers: { cookie: ownerCookie } });
  assert.equal(blockedTaskRead.status, 403);
  assert.equal((await blockedTaskRead.json()).code, 'OWNER_PASSWORD_CHANGE_REQUIRED');

  const rejectedRotation = await fetch(base + '/api/owner/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie, 'x-orient-csrf': 'wrong-token' },
    body: JSON.stringify({ password: permanentPassword, confirmPassword: permanentPassword })
  });
  assert.equal(rejectedRotation.status, 403);

  const rotation = await fetch(base + '/api/owner/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie, 'x-orient-csrf': loginData.csrfToken },
    body: JSON.stringify({ password: permanentPassword, confirmPassword: permanentPassword })
  });
  assert.equal(rotation.status, 200);
  const rotationData = await rotation.json();
  assert.equal(rotationData.passwordChangeRequired, false);
  ownerCookie = cookie(rotation);

  const runtimeSession = await fetch(base + '/owner/session', { headers: { cookie: ownerCookie } });
  assert.equal(runtimeSession.status, 200);
  const runtimeSessionData = await runtimeSession.json();
  assert.equal(runtimeSessionData.passwordChangeRequired, false);
  assert.equal(runtimeSessionData.csrfToken, rotationData.csrfToken);

  const taskRead = await fetch(base + '/api/v1/tasks', { headers: { cookie: ownerCookie } });
  assert.equal(taskRead.status, 200);
  assert.deepEqual(await taskRead.json(), { ok: true, tasks: [] });

  const publicRegistration = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'PublicTester', password: 'public-user-password-2026!' })
  });
  assert.equal(publicRegistration.status, 201);
  const publicCookie = cookie(publicRegistration);
  const publicRuntimeRead = await fetch(base + '/api/v1/tasks', { headers: { cookie: publicCookie } });
  assert.equal(publicRuntimeRead.status, 401);
  assert.equal((await publicRuntimeRead.json()).code, 'OWNER_AUTH_REQUIRED');

  const runtimeLogin = await fetch(base + '/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password: permanentPassword })
  });
  assert.equal(runtimeLogin.status, 200);
  const runtimeLoginData = await runtimeLogin.json();
  const runtimeCookie = cookie(runtimeLogin);

  const runtimeRotation = await fetch(base + '/owner/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: runtimeCookie, 'x-orient-csrf': runtimeLoginData.csrfToken },
    body: JSON.stringify({ password: 'runtime-rotated-owner-password-7Q!', confirmPassword: 'runtime-rotated-owner-password-7Q!' })
  });
  assert.equal(runtimeRotation.status, 200);
  const runtimeRotationData = await runtimeRotation.json();
  const nextRuntimeCookie = cookie(runtimeRotation);
  assert.equal(runtimeRotationData.passwordChangeRequired, false);
  assert.equal((await fetch(base + '/owner/session', { headers: { cookie: runtimeCookie } })).status, 401);
  const websiteSeesRuntimeSession = await fetch(base + '/api/owner/me', { headers: { cookie: nextRuntimeCookie } });
  assert.equal(websiteSeesRuntimeSession.status, 200);
  assert.equal((await websiteSeesRuntimeSession.json()).csrfToken, runtimeRotationData.csrfToken);

  const oldOwnerCookieRead = await fetch(base + '/owner/session', {
    headers: { cookie: login.headers.get('set-cookie').split(';')[0] }
  });
  assert.equal(oldOwnerCookieRead.status, 401);

  const ownerState = JSON.parse(fs.readFileSync(path.join(dataDir, 'owner.json'), 'utf8'));
  assert.equal(ownerState.mustChangePassword, false);
  assert.equal(typeof ownerState.passwordHash, 'string');
  assert.equal(Object.hasOwn(ownerState, 'password'), false);
});
