'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');
const OwnerIdentityRuntimeAdapter = require('../../src/core/security/owner-identity-runtime-adapter');
const { createOwnerServer } = require('../../server');
const createServer = require('../../src/interfaces/http/server');

test('website owner identity is composed into the same HTTP server as Runtime routes', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-runtime-composition-'));
  const identity = new OwnerIdentityService({ stateFile: path.join(dataDir, 'owner.json'), bootstrapPassword: 'temporary-test-password' });
  const ownerAuth = new OwnerIdentityRuntimeAdapter({ identity });
  const website = createOwnerServer({ dataDir, identity: ownerAuth, log: () => {} });
  const server = createServer({ memoryRoutes: { home(_req, res) { res.writeHead(200); res.end('home'); } }, agentRoutes: {}, ownerAuth, websiteHandler: website.handler });
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise(resolve => website.server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const status = await fetch(origin + '/api/owner/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).passwordChangeRequired, true);
  assert.equal(website.server.listening, false);
});
