'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOwnerServer } = require('../../server');

test('website passes the socket peer address to the shared owner login limiter', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-login-ip-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  let observedSourceIp;
  const identity = {
    login: async ({ username, password, sourceIp }) => {
      assert.equal(username, 'Admin');
      assert.equal(password, 'wrong-password');
      observedSourceIp = sourceIp;
      return { ok: false, code: 'OWNER_LOGIN_FAILED' };
    },
    authenticate: () => null,
    verifyCsrf: () => false,
    changePassword: async () => ({ ok: false, code: 'OWNER_AUTH_REQUIRED' }),
    logout: () => false,
    status: () => ({ passwordChangeRequired: false, configured: true })
  };

  const instance = createOwnerServer({ dataDir, identity, log: () => {} });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => instance.server.close(() => resolve())));

  const response = await fetch('http://127.0.0.1:' + instance.server.address().port + '/api/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Admin', password: 'wrong-password' })
  });

  assert.equal(response.status, 401);
  assert.equal(typeof observedSourceIp, 'string');
  assert.notEqual(observedSourceIp, 'unknown', 'HTTP requests must not share the adapter fallback lockout bucket');
  assert.match(observedSourceIp, /127\\.0\\.0\\.1|::1|::ffff:127\\.0\\.0\\.1/);
});
