'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  Ed25519IdentityTokenIssuer,
  Ed25519IdentityTokenVerifier
} = require('../../../../src/infrastructure/gateway/identity/ed25519-identity-token');
const {
  GatewayIdentityExecutionService
} = require('../../../../src/infrastructure/gateway/identity/gateway-identity-execution-service');

const IDS = {
  owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  challenge: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  operation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  request: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
};
const NOW = 1_800_000_000_000;

function fixture({ scope = ['execution.read'] } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const issuer = new Ed25519IdentityTokenIssuer({
    privateKey,
    kid: 'gateway-test-key',
    now: () => NOW
  });
  const verifier = new Ed25519IdentityTokenVerifier({
    publicKeys: new Map([['gateway-test-key', publicKey]]),
    now: () => NOW
  });
  const calls = [];
  const repository = {
    async executeAtomically(input) {
      calls.push(input);
      return { replayed: false, response: { accepted: true } };
    }
  };
  const service = new GatewayIdentityExecutionService({
    tokenVerifier: verifier,
    gatewayIdentityRepository: repository
  });
  const principal = {
    principalId: IDS.owner,
    ownerId: IDS.owner,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    sessionId: IDS.session
  };
  const token = issuer.issue({
    principal,
    challengeId: IDS.challenge,
    operation: 'execution.get',
    operationId: IDS.operation,
    requestId: IDS.request,
    scope
  });
  return { service, calls, token };
}

const input = token => ({
  token,
  challengeId: IDS.challenge,
  operation: 'execution.get',
  operationId: IDS.operation,
  requestId: IDS.request,
  idempotencyKey: 'request-key-1',
  request: { executionId: 'execution-1' },
  execute: async () => ({ accepted: true })
});

test('gateway execution derives the database principal and bindings only from a verified token', async () => {
  const { service, calls, token } = fixture();
  const result = await service.execute({
    ...input(token),
    ownerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    tenantId: 'tenant-attacker',
    workspaceId: 'workspace-attacker',
    sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  });

  assert.deepEqual(result, { replayed: false, response: { accepted: true } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].principal, {
    principalId: IDS.owner,
    ownerId: IDS.owner,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    authSource: 'orient-owner-session',
    sessionId: IDS.session
  });
  assert.deepEqual(calls[0].binding, {
    ownerId: IDS.owner,
    sessionId: IDS.session,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    challengeId: IDS.challenge,
    operation: 'execution.get',
    operationId: IDS.operation,
    requestId: IDS.request
  });
});

test('gateway execution rejects a request whose challenge or operation binding differs from the signed token', async () => {
  const { service, calls, token } = fixture();
  await assert.rejects(
    () => service.execute({ ...input(token), operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    error => error.code === 'IDENTITY_TOKEN_REQUEST_BINDING_MISMATCH'
  );
  await assert.rejects(
    () => service.execute({ ...input(token), challengeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    error => error.code === 'IDENTITY_TOKEN_REQUEST_BINDING_MISMATCH'
  );
  assert.equal(calls.length, 0);
});

test('gateway execution rejects unmapped operations before repository access', async () => {
  const { service, calls, token } = fixture();
  await assert.rejects(
    () => service.execute({ ...input(token), operation: 'tenant.admin.delete' }),
    error => error.code === 'GATEWAY_OPERATION_DENIED'
  );
  assert.equal(calls.length, 0);
});

test('gateway execution rejects a token carrying broader scope than the operation policy', async () => {
  const { service, calls, token } = fixture({
    scope: ['execution.read', 'approval.decide']
  });
  await assert.rejects(
    () => service.execute(input(token)),
    error => error.code === 'GATEWAY_SCOPE_POLICY_REJECTED'
  );
  assert.equal(calls.length, 0);
});

test('gateway execution requires the live owner session to match the signed session claim', async () => {
  const { service, calls, token } = fixture();
  service.sessionAuthorizer = async ({ sessionId }) => sessionId === IDS.session;
  await assert.rejects(
    () => service.execute({ ...input(token), ownerSessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    error => error.code === 'GATEWAY_SESSION_REJECTED'
  );
  service.sessionAuthorizer = async () => false;
  await assert.rejects(
    () => service.execute({ ...input(token), ownerSessionId: IDS.session }),
    error => error.code === 'GATEWAY_SESSION_REJECTED'
  );
  assert.equal(calls.length, 0);
});

test('gateway execution rejects absent idempotency keys and missing database mutation handlers', async () => {
  const { service, calls, token } = fixture();
  await assert.rejects(
    () => service.execute({ ...input(token), idempotencyKey: '' }),
    error => error.code === 'GATEWAY_EXECUTION_INPUT_INVALID'
  );
  await assert.rejects(
    () => service.execute({ ...input(token), execute: null }),
    error => error.code === 'GATEWAY_EXECUTION_INPUT_INVALID'
  );
  assert.equal(calls.length, 0);
});
