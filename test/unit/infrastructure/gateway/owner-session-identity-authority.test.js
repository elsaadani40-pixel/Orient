'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OwnerSessionIdentityAuthority } = require('../../../../src/infrastructure/gateway/identity/owner-session-identity-authority');

const IDS = {
  owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  challenge: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  operation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  request: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
};

function fixture(overrides = {}) {
  const calls = [];
  const session = { ownerId: IDS.owner, sessionId: IDS.session };
  const challenge = {
    challengeId: IDS.challenge,
    status: 'ISSUED',
    expiresAt: 1_900_000_000_000,
    ownerId: IDS.owner,
    sessionId: IDS.session,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    operation: 'execution.get',
    operationId: IDS.operation,
    requestId: IDS.request,
    requestFingerprint: 'a'.repeat(64)
  };
  const authority = new OwnerSessionIdentityAuthority({
    ownerIdentity: {
      authenticate: token => token === 'valid-session-token' ? session : null,
      isActiveSession: id => id === IDS.session
    },
    tokenIssuer: { issue: input => { calls.push(input); return 'signed-proof'; } },
    challengeStore: { getForIssuance: async () => ({ ...challenge, ...overrides.challenge }) },
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    now: () => 1_800_000_000_000
  });
  return { authority, calls };
}

const validRequest = {
  ownerSessionToken: 'valid-session-token',
  challengeId: IDS.challenge,
  operation: 'execution.get',
  operationId: IDS.operation,
  requestId: IDS.request
};

test('issues a token only from the canonical live owner session and bound gateway challenge', async () => {
  const { authority, calls } = fixture();
  const result = await authority.issueForSession(validRequest);
  assert.equal(result.token, 'signed-proof');
  assert.equal(result.requiredScope, 'execution.read');
  assert.deepEqual(calls[0].principal, {
    principalId: IDS.owner,
    ownerId: IDS.owner,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    authSource: 'orient-owner-session',
    sessionId: IDS.session
  });
  assert.deepEqual(calls[0].scope, ['execution.read']);
});

test('does not accept a caller-supplied principal or scope', async () => {
  const { authority, calls } = fixture();
  await authority.issueForSession({
    ...validRequest,
    principal: { ownerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    scope: ['approval.decide']
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scope, ['execution.read']);
  assert.equal(calls[0].principal.ownerId, IDS.owner);
});

test('rejects absent or invalid owner sessions before reading a challenge', async () => {
  const { authority, calls } = fixture();
  await assert.rejects(
    authority.issueForSession({ ...validRequest, ownerSessionToken: 'forged' }),
    { code: 'IDENTITY_AUTH_SESSION_REJECTED' }
  );
  assert.equal(calls.length, 0);
});

test('rejects a revoked owner session', async () => {
  const { authority } = fixture();
  authority.ownerIdentity.isActiveSession = () => false;
  await assert.rejects(authority.issueForSession(validRequest), {
    code: 'IDENTITY_AUTH_SESSION_REJECTED'
  });
});

test('rejects an expired or consumed challenge', async () => {
  const expired = fixture({ challenge: { expiresAt: 1_700_000_000_000 } });
  await assert.rejects(expired.authority.issueForSession(validRequest), {
    code: 'IDENTITY_AUTH_CHALLENGE_REJECTED'
  });
  const consumed = fixture({ challenge: { status: 'CONSUMED' } });
  await assert.rejects(consumed.authority.issueForSession(validRequest), {
    code: 'IDENTITY_AUTH_CHALLENGE_REJECTED'
  });
});

test('rejects challenge substitution across owner, tenant, operation and request', async () => {
  for (const change of [
    { ownerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    { tenantId: 'tenant-b' },
    { operation: 'approval.decide' },
    { operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    { requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }
  ]) {
    const { authority } = fixture({ challenge: change });
    await assert.rejects(authority.issueForSession(validRequest), {
      code: 'IDENTITY_AUTH_CHALLENGE_BINDING_MISMATCH'
    });
  }
});

test('rejects operations without an explicit scope mapping', async () => {
  const { authority, calls } = fixture();
  await assert.rejects(
    authority.issueForSession({ ...validRequest, operation: 'tenant.admin.update' }),
    { code: 'IDENTITY_AUTH_OPERATION_DENIED' }
  );
  assert.equal(calls.length, 0);
});
