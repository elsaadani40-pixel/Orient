'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createServer = require('../../../../src/interfaces/http/server');

function post(port, path, { cookie = 'orient_owner_session=valid-session', csrf = 'valid-csrf', authorization = null, idempotencyKey = null, body = { operation: 'execution.get', request: { id: 'task-1' } } } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
      origin: 'http://127.0.0.1:' + port, host: '127.0.0.1:' + port,
      cookie, 'x-orient-csrf': csrf, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      ...(authorization ? { authorization } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(payload);
  });
}

test('Gateway challenge and token endpoints require an owner session and CSRF proof', async () => {
  const calls = [];
  const server = createServer({
    memoryRoutes: {}, agentRoutes: {},
    ownerAuth: {
      enabled: true,
      authenticate(token) { return token === 'valid-session' ? { ownerId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222', csrfToken: 'valid-csrf', principal: {} } : null; },
      status() { return { passwordChangeRequired: false }; },
      verifyCsrf(_session, token) { return token === 'valid-csrf'; }
    },
    gatewayIdentityRoutes: {
      async createChallenge(input) { calls.push(['challenge', input]); return { challengeId: '33333333-3333-4333-8333-333333333333' }; },
      async issueToken(input) { calls.push(['token', input]); return { token: 'signed-proof', requiredScope: 'execution.read' }; }
    },
    gatewayIdentityExecutionService: {
      async execute(input) {
        calls.push(['execute', input]);
        const response = await input.execute({ query: async () => ({ rows: [] }) }, {
          principal: { ownerId: '11111111-1111-4111-8111-111111111111', tenantId: 'tenant-a' }
        });
        return { replayed: false, response };
      }
    },
    gatewayOperationHandlers: new Map([['execution.get', async (_client, context) => ({
      found: true, task: { id: context.request.executionId, tenant: context.principal.tenantId }
    })]])
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const denied = await post(port, '/owner/gateway/challenges', { cookie: 'orient_owner_session=invalid-session' });
    assert.equal(denied.statusCode, 401);
    const csrfDenied = await post(port, '/owner/gateway/challenges', { csrf: 'wrong' });
    assert.equal(csrfDenied.statusCode, 403);
    const created = await post(port, '/owner/gateway/challenges');
    assert.equal(created.statusCode, 201);
    assert.equal(calls[0][0], 'challenge');
    const issued = await post(port, '/owner/gateway/identity-token', { body: {
      challengeId: '33333333-3333-4333-8333-333333333333', operation: 'execution.get',
      operationId: '44444444-4444-4444-8444-444444444444', requestId: '55555555-5555-4555-8555-555555555555'
    }});
    assert.equal(issued.statusCode, 200);
    assert.equal(calls[1][1].ownerSessionToken, 'valid-session');
    assert.equal(issued.body.identity.token, 'signed-proof');
    const executed = await post(port, '/owner/gateway/execute', {
      authorization: 'Bearer signed-proof',
      idempotencyKey: 'gateway-http-key',
      body: {
        challengeId: '33333333-3333-4333-8333-333333333333',
        operation: 'execution.get',
        operationId: '44444444-4444-4444-8444-444444444444',
        requestId: '55555555-5555-4555-8555-555555555555',
        request: { executionId: 'task-123' }
      }
    });
    assert.equal(executed.statusCode, 200);
    assert.deepEqual(executed.body.response, {
      found: true, task: { id: 'task-123', tenant: 'tenant-a' }
    });
    assert.equal(calls[2][0], 'execute');
    assert.equal(calls[2][1].ownerSessionId, '22222222-2222-4222-8222-222222222222');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
