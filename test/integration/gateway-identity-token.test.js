'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  Ed25519IdentityTokenIssuer,
  Ed25519IdentityTokenVerifier
} = require('../../src/infrastructure/gateway/identity/ed25519-identity-token');

const UUIDS = {
  owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  challenge: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  operation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  request: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
};

function fixture() {
  let now = 1_800_000_000_000;
  const pair = crypto.generateKeyPairSync('ed25519');
  const issuer = new Ed25519IdentityTokenIssuer({
    privateKey: pair.privateKey,
    kid: 'test-key-1',
    now: () => now
  });
  const verifier = new Ed25519IdentityTokenVerifier({
    publicKeys: new Map([['test-key-1', pair.publicKey]]),
    now: () => now
  });
  const input = {
    principal: {
      principalId: UUIDS.owner,
      ownerId: UUIDS.owner,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: UUIDS.session
    },
    challengeId: UUIDS.challenge,
    operation: 'execution.get',
    operationId: UUIDS.operation,
    requestId: UUIDS.request,
    scope: ['execution.read']
  };
  return {
    issuer,
    verifier,
    privateKey: pair.privateKey,
    input,
    advance: milliseconds => { now += milliseconds; }
  };
}

test('issues and verifies an Ed25519 token bound to one gateway request', () => {
  const { issuer, verifier, input } = fixture();
  const token = issuer.issue(input);
  const claims = verifier.verify(token, {
    challenge_id: UUIDS.challenge,
    operation: 'execution.get',
    operation_id: UUIDS.operation,
    request_id: UUIDS.request,
    requiredScope: 'execution.read'
  });

  assert.equal(claims.owner_id, UUIDS.owner);
  assert.equal(claims.tenant_id, 'tenant-a');
  assert.equal(claims.workspace_id, 'workspace-a');
  assert.equal(claims.session_id, UUIDS.session);
  assert.equal(claims.aud, 'orient-database-gateway');
  assert.equal(claims.exp - claims.iat, 30);
  assert.equal(Object.isFrozen(claims), true);
  assert.equal(Object.isFrozen(claims.scope), true);
});

test('rejects a token whose request binding does not match the received request', () => {
  const { issuer, verifier, input } = fixture();
  const token = issuer.issue(input);
  assert.throws(
    () => verifier.verify(token, { operation_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    { code: 'IDENTITY_TOKEN_REQUEST_BINDING_MISMATCH' }
  );
});

test('rejects modified token payloads and signatures', () => {
  const { issuer, verifier, input } = fixture();
  const token = issuer.issue(input);
  const [header, payload, signature] = token.split('.');
  const alteredPayload = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    tenant_id: 'tenant-b'
  })).toString('base64url');
  assert.throws(
    () => verifier.verify(header + '.' + alteredPayload + '.' + signature),
    { code: 'IDENTITY_TOKEN_SIGNATURE_INVALID' }
  );
});

test('rejects unknown signing keys', () => {
  const { issuer, input, verifier } = fixture();
  const token = issuer.issue(input);
  const unknownKeyIssuer = new Ed25519IdentityTokenIssuer({
    privateKey: crypto.generateKeyPairSync('ed25519').privateKey,
    kid: 'untrusted-key',
    now: () => 1_800_000_000_000
  });
  const unknownToken = unknownKeyIssuer.issue(input);
  assert.throws(() => verifier.verify(unknownToken), { code: 'IDENTITY_TOKEN_KEY_UNKNOWN' });
  assert.equal(typeof token, 'string');
});

test('rejects signed tokens containing claims outside the fixed identity contract', () => {
  const { issuer, verifier, privateKey, input } = fixture();
  const original = issuer.issue(input);
  const [header, payload] = original.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.privileged = true;
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = header + '.' + encodedClaims;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey).toString('base64url');
  assert.throws(
    () => verifier.verify(signingInput + '.' + signature),
    { code: 'IDENTITY_TOKEN_CLAIMS_REJECTED' }
  );
});

test('rejects expired tokens', () => {
  const { issuer, verifier, input, advance } = fixture();
  const token = issuer.issue({ ...input, ttlSeconds: 5 });
  advance(8_000);
  assert.throws(() => verifier.verify(token), { code: 'IDENTITY_TOKEN_TIME_INVALID' });
});

test('rejects an issuer request that attempts to exceed the short token lifetime', () => {
  const { issuer, input } = fixture();
  assert.throws(
    () => issuer.issue({ ...input, ttlSeconds: 61 }),
    { code: 'IDENTITY_TOKEN_TTL_REJECTED' }
  );
});

test('rejects a principal whose principal id differs from its owner id', () => {
  const { issuer, input } = fixture();
  assert.throws(
    () => issuer.issue({
      ...input,
      principal: { ...input.principal, principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }
    }),
    { code: 'IDENTITY_TOKEN_PRINCIPAL_INVALID' }
  );
});

test('rejects a request token without a unique scope list', () => {
  const { issuer, input } = fixture();
  assert.throws(
    () => issuer.issue({ ...input, scope: ['execution.read', 'execution.read'] }),
    { code: 'IDENTITY_TOKEN_SCOPE_INVALID' }
  );
});
