'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGatewayIdentityRoutes } = require('../../../../src/interfaces/http/routes/gateway-identity.routes');
const ownerId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const principal = { principalId: ownerId, ownerId, sessionId, tenantId: 'tenant-a', workspaceId: 'workspace-a', authSource: 'orient-owner-session' };
test('persists owner-scoped challenge and delegates token signing', async () => {
  const saved = []; const signed = [];
  const routes = createGatewayIdentityRoutes({
    repository: { issue: async (challenge, options) => saved.push({ challenge, options }) },
    authority: { operationScopes: new Map([['execution.get', 'execution.read']]), issueForSession: async input => { signed.push(input); return { token: 'signed', requiredScope: 'execution.read' }; } },
    tenantId: 'tenant-a', workspaceId: 'workspace-a', now: () => 10000, challengeTtlMs: 20000
  });
  const challenge = await routes.createChallenge({ ownerSession: { ownerId, sessionId, principal }, operation: 'execution.get', request: { id: 'task-1' } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].options.principal, principal);
  assert.equal(challenge.expiresAt, 30000);
  const token = await routes.issueToken({ ownerSessionToken: 'opaque-session-token', challengeId: challenge.challengeId, operation: challenge.operation, operationId: challenge.operationId, requestId: challenge.requestId });
  assert.equal(token.token, 'signed');
  assert.equal(signed.length, 1);
});
test('rejects unapproved operation and missing owner session', async () => {
  const routes = createGatewayIdentityRoutes({ repository: { issue: async () => assert.fail() }, authority: { operationScopes: new Map([['execution.get', 'execution.read']]), issueForSession: async () => assert.fail() }, tenantId: 'tenant-a', workspaceId: 'workspace-a' });
  await assert.rejects(routes.createChallenge({ ownerSession: { ownerId, sessionId, principal }, operation: 'database.sql' }), e => e.code === 'IDENTITY_AUTH_OPERATION_DENIED');
  await assert.rejects(routes.createChallenge({ ownerSession: null, operation: 'execution.get' }), e => e.code === 'IDENTITY_AUTH_SESSION_REJECTED');
  await assert.rejects(routes.createChallenge({ ownerSession: { ownerId, sessionId, principal }, operation: 'execution.get' }), e => e.code === 'GATEWAY_REQUEST_NOT_JSON');
});
