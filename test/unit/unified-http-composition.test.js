'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createServer = require('../../src/interfaces/http/server');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OwnerWorkProfileStore } = require('../../src/infrastructure/persistence/owner-work-profile-store');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve('http://127.0.0.1:' + server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('unified HTTP composition delegates website routes without shadowing Runtime owner routes', async t => {
  const delegated = [];
  const websiteHandler = async (req, res) => {
    delegated.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('website:' + req.url);
  };
  const server = createServer({ websiteHandler, memoryRoutes: { home(_req, res, url) { res.writeHead(200); res.end('memory:' + url.pathname); } }, agentRoutes: { async tasks(_req, res) { res.writeHead(200); res.end('runtime-tasks'); } } });
  const base = await listen(server);
  t.after(() => close(server));

  const publicAuth = await fetch(base + '/api/auth/me');
  assert.equal(publicAuth.status, 200);
  assert.equal(await publicAuth.text(), 'website:/api/auth/me');

  const asset = await fetch(base + '/assets/site.css');
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'website:/assets/site.css');

  const homepage = await fetch(base + '/');
  assert.equal(homepage.status, 200);
  assert.equal(await homepage.text(), 'website:/');

  const memory = await fetch(base + '/memory');
  assert.equal(memory.status, 200);
  assert.equal(await memory.text(), 'memory:/memory');

  const runtimeOwner = await fetch(base + '/owner');
  assert.equal(runtimeOwner.status, 200);
  assert.match(await runtimeOwner.text(), /ORIENT|owner|dashboard/i);

  assert.deepEqual(delegated, ['/api/auth/me', '/assets/site.css', '/']);
});

test('website delegation does not intercept Runtime task API routes', async t => {
  const delegated = [];
  const websiteHandler = async (req, res) => {
    delegated.push(req.url);
    res.writeHead(200);
    res.end('website');
  };
  const server = createServer({ websiteHandler, ownerAuth: null, agentRoutes: { async tasks(_req, res) { res.writeHead(200); res.end('runtime-tasks'); } } });
  const base = await listen(server);
  t.after(() => close(server));

  const response = await fetch(base + '/api/v1/tasks');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'runtime-tasks');
  assert.deepEqual(delegated, []);
});


test('owner work profile API requires owner session and CSRF-protected same-origin updates', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-owner-profile-http-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ownerProfile = new OwnerWorkProfileStore({ filePath: path.join(dir, 'owner-profile.json') });
  const ownerAuth = {
    enabled: true,
    authenticate(token) { return token === 'valid-session' ? { csrfToken: 'csrf-token', expiresAt: Date.now() + 60000 } : null; },
    verifyCsrf(session, token) { return session?.csrfToken === token; },
    status() { return { passwordChangeRequired: false }; }
  };
  const server = createServer({ ownerAuth, ownerProfile });
  const base = await listen(server);
  t.after(() => close(server));

  const denied = await fetch(base + '/owner/profile');
  assert.equal(denied.status, 401);

  const read = await fetch(base + '/owner/profile', { headers: { Cookie: 'orient_owner_session=valid-session' } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).profile.mode, 'standard');

  const rejected = await fetch(base + '/owner/profile', {
    method: 'PUT',
    headers: { Cookie: 'orient_owner_session=valid-session', Origin: base, 'Content-Type': 'application/json', 'X-ORIENT-CSRF': 'wrong-token' },
    body: JSON.stringify({ mode: 'plan-only', workingPreferences: 'Do not execute during planning.' })
  });
  assert.equal(rejected.status, 403);

  const saved = await fetch(base + '/owner/profile', {
    method: 'PUT',
    headers: { Cookie: 'orient_owner_session=valid-session', Origin: base, 'Content-Type': 'application/json', 'X-ORIENT-CSRF': 'csrf-token' },
    body: JSON.stringify({ mode: 'plan-only', workingPreferences: 'Inspect evidence, plan, then test.' })
  });
  assert.equal(saved.status, 200);
  const payload = await saved.json();
  assert.equal(payload.profile.mode, 'plan-only');
  assert.equal(payload.profile.workingPreferences, 'Inspect evidence, plan, then test.');

  const reread = await fetch(base + '/owner/profile', { headers: { Cookie: 'orient_owner_session=valid-session' } });
  assert.deepEqual((await reread.json()).profile, payload.profile);
});
