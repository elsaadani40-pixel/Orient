'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createServer = require('../../src/interfaces/http/server');

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
  const server = createServer({ websiteHandler, agentRoutes: { async tasks(_req, res) { res.writeHead(200); res.end('runtime-tasks'); } } });
  const base = await listen(server);
  t.after(() => close(server));

  const publicAuth = await fetch(base + '/api/auth/me');
  assert.equal(publicAuth.status, 200);
  assert.equal(await publicAuth.text(), 'website:/api/auth/me');

  const asset = await fetch(base + '/assets/site.css');
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'website:/assets/site.css');

  const runtimeOwner = await fetch(base + '/owner');
  assert.equal(runtimeOwner.status, 200);
  assert.match(await runtimeOwner.text(), /ORIENT|owner|dashboard/i);

  assert.deepEqual(delegated, ['/api/auth/me', '/assets/site.css']);
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
