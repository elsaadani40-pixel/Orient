'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createServer = require('../../../../src/interfaces/http/server');

function get(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path, headers: { 'user-agent': 'audit-test' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
  });
}

test('HTTP server records bounded access metadata without query strings', async () => {
  const events = [];
  const server = createServer({
    memoryRoutes: {
      home(_req, res) { res.writeHead(200); res.end('ok'); },
      add() {},
      delete() {}
    },
    agentRoutes: {},
    accessAudit: { async record(event) { events.push(event); } }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await get(address.port, '/?token=private-value');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(response.statusCode, 200);
    assert.ok(response.headers['x-request-id']);
    assert.equal(events.length, 1);
    assert.equal(events[0].requestId, response.headers['x-request-id']);
    assert.equal(events[0].route, '/');
    assert.equal(events[0].sourceIp, '127.0.0.1');
    assert.equal(events[0].statusCode, 200);
    assert.equal(JSON.stringify(events[0]).includes('private-value'), false);
    assert.equal(Object.hasOwn(events[0], 'headers'), false);
    assert.equal(Object.hasOwn(events[0], 'body'), false);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
