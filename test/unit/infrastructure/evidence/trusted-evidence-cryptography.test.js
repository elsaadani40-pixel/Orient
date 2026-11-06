'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEvidenceRecord } = require('../../../../src/core/execution/evidence-record');
const {
  signEvidenceEnvelope,
  verifyEvidenceEnvelope,
  createEvidenceAnchor,
  verifyEvidenceAnchor
} = require('../../../../src/infrastructure/evidence/trusted-evidence-cryptography');

function setup() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const evidence = createEvidenceRecord({
    executionId: 'exec-ledger-test',
    step: 1,
    tool: 'execution.get',
    success: true,
    result: { status: 'completed', count: 3 },
    observedAt: '2026-11-06T10:00:00.000Z'
  });
  return { privateKey, publicKey, evidence, trustedKeys: { 'test-key-1': { publicKey } } };
}

test('trusted evidence envelope signs and verifies with Ed25519', () => {
  const fixture = setup();
  const envelope = signEvidenceEnvelope({
    tenantId: 'tenant-a',
    executionId: fixture.evidence.executionId,
    sequence: 1,
    evidence: fixture.evidence,
    previousHash: null
  }, {
    keyId: 'test-key-1',
    privateKey: fixture.privateKey,
    recordedAt: '2026-11-06T10:01:00.000Z'
  });

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.sequence, 1);
  assert.equal(envelope.previousHash, null);
  assert.match(envelope.recordHash, /^[a-f0-9]{64}$/);
  assert.equal(verifyEvidenceEnvelope(envelope, fixture.trustedKeys), true);
});

test('trusted evidence envelope rejects payload and chain metadata tampering', () => {
  const fixture = setup();
  const envelope = signEvidenceEnvelope({
    tenantId: 'tenant-a',
    executionId: fixture.evidence.executionId,
    sequence: 1,
    evidence: fixture.evidence,
    previousHash: null
  }, {
    keyId: 'test-key-1',
    privateKey: fixture.privateKey,
    recordedAt: '2026-11-06T10:01:00.000Z'
  });

  for (const changed of [
    { ...envelope, tenantId: 'tenant-b' },
    { ...envelope, executionId: 'exec-other' },
    { ...envelope, sequence: 2 },
    { ...envelope, previousHash: 'a'.repeat(64) },
    { ...envelope, evidence: { ...fixture.evidence, operation: 'different.tool' } },
    { ...envelope, keyId: 'unknown-key' },
    { ...envelope, recordedAt: '2026-11-06T10:02:00.000Z' },
    { ...envelope, recordHash: 'b'.repeat(64) },
    { ...envelope, signature: Buffer.alloc(64, 7).toString('base64') }
  ]) {
    assert.equal(verifyEvidenceEnvelope(changed, fixture.trustedKeys), false);
  }
});

test('trusted evidence envelope rejects unknown keys and invalid key types', () => {
  const fixture = setup();
  assert.throws(
    () => signEvidenceEnvelope({
      tenantId: 'tenant-a',
      executionId: fixture.evidence.executionId,
      sequence: 1,
      evidence: fixture.evidence,
      previousHash: null
    }, { keyId: 'test-key-1', privateKey: 'not-a-private-key' }),
    error => error.code === 'EVIDENCE_SIGNING_KEY_INVALID'
  );
  assert.equal(
    verifyEvidenceEnvelope(
      signEvidenceEnvelope({
        tenantId: 'tenant-a',
        executionId: fixture.evidence.executionId,
        sequence: 1,
        evidence: fixture.evidence,
        previousHash: null
      }, {
        keyId: 'test-key-1',
        privateKey: fixture.privateKey,
        recordedAt: '2026-11-06T10:01:00.000Z'
      }),
      {}
    ),
    false
  );
});

test('trusted evidence envelope enforces key validity and revocation timestamps', () => {
  const fixture = setup();
  const envelope = signEvidenceEnvelope({
    tenantId: 'tenant-a',
    executionId: fixture.evidence.executionId,
    sequence: 1,
    evidence: fixture.evidence,
    previousHash: null
  }, {
    keyId: 'test-key-1',
    privateKey: fixture.privateKey,
    recordedAt: '2026-11-06T10:01:00.000Z'
  });

  assert.equal(verifyEvidenceEnvelope(envelope, {
    'test-key-1': {
      publicKey: fixture.trustedKeys['test-key-1'].publicKey,
      validFrom: '2026-11-06T10:02:00.000Z'
    }
  }), false);
  assert.equal(verifyEvidenceEnvelope(envelope, {
    'test-key-1': {
      publicKey: fixture.trustedKeys['test-key-1'].publicKey,
      revokedAt: '2026-11-06T10:00:00.000Z'
    }
  }), false);
  assert.equal(verifyEvidenceEnvelope(envelope, {
    'test-key-1': {
      publicKey: fixture.trustedKeys['test-key-1'].publicKey,
      revokedAt: '2026-11-06T10:02:00.000Z'
    }
  }), true);
});


test('trusted evidence key rotation preserves historical verification and rejects post-revocation signatures', () => {
  const fixture = setup();
  const nextPair = crypto.generateKeyPairSync('ed25519');
  const nextPrivateKey = nextPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const nextPublicKey = nextPair.publicKey.export({ type: 'spki', format: 'pem' });
  const input = {
    tenantId: 'tenant-a',
    executionId: fixture.evidence.executionId,
    sequence: 1,
    evidence: fixture.evidence,
    previousHash: null
  };
  const oldEnvelope = signEvidenceEnvelope(input, {
    keyId: 'test-key-1',
    privateKey: fixture.privateKey,
    recordedAt: '2026-11-06T10:01:00.000Z'
  });
  const newEnvelope = signEvidenceEnvelope(input, {
    keyId: 'test-key-2',
    privateKey: nextPrivateKey,
    recordedAt: '2026-11-06T10:03:00.000Z'
  });
  const trustManifest = {
    'test-key-1': {
      publicKey: fixture.publicKey,
      validFrom: '2026-11-06T09:00:00.000Z',
      revokedAt: '2026-11-06T10:02:00.000Z'
    },
    'test-key-2': {
      publicKey: nextPublicKey,
      validFrom: '2026-11-06T10:02:00.000Z'
    }
  };

  assert.equal(verifyEvidenceEnvelope(oldEnvelope, trustManifest), true);
  assert.equal(verifyEvidenceEnvelope(newEnvelope, trustManifest), true);

  const postRevocationEnvelope = signEvidenceEnvelope({
    ...input,
    sequence: 2,
    previousHash: oldEnvelope.recordHash
  }, {
    keyId: 'test-key-1',
    privateKey: fixture.privateKey,
    recordedAt: '2026-11-06T10:03:00.000Z'
  });
  assert.equal(verifyEvidenceEnvelope(postRevocationEnvelope, trustManifest), false);
});

test('external evidence anchors require a separate trusted Ed25519 key and detect tampering', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const anchor = createEvidenceAnchor({
    tenantId: 'tenant-a',
    executionId: 'exec-ledger-test',
    sequence: 4,
    recordHash: 'a'.repeat(64),
    anchoredAt: '2026-11-06T10:10:00.000Z'
  }, { keyId: 'owner-anchor-key-1', privateKey });
  const trustedKeys = {
    'owner-anchor-key-1': { publicKey, validFrom: '2026-11-06T10:00:00.000Z' }
  };

  assert.equal(verifyEvidenceAnchor(anchor, trustedKeys), true);
  assert.equal(verifyEvidenceAnchor({ ...anchor, tenantId: 'tenant-b' }, trustedKeys), false);
  assert.equal(verifyEvidenceAnchor({ ...anchor, sequence: 5 }, trustedKeys), false);
  assert.equal(verifyEvidenceAnchor({ ...anchor, recordHash: 'b'.repeat(64) }, trustedKeys), false);
  assert.equal(verifyEvidenceAnchor({ ...anchor, anchoredAt: '2026-11-06T10:11:00.000Z' }, trustedKeys), false);
  assert.equal(verifyEvidenceAnchor(anchor, {}), false);
});


test('external evidence anchor rejects invalid trusted key validity metadata', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const anchor = createEvidenceAnchor({
    tenantId: 'tenant-a',
    executionId: 'exec-ledger-test',
    sequence: 1,
    recordHash: 'c'.repeat(64),
    anchoredAt: '2026-11-06T10:10:00.000Z'
  }, { keyId: 'owner-anchor-key-2', privateKey });
  assert.equal(verifyEvidenceAnchor(anchor, {
    'owner-anchor-key-2': { publicKey, validFrom: 'not-a-date' }
  }), false);
  assert.equal(verifyEvidenceAnchor(anchor, {
    'owner-anchor-key-2': {
      publicKey,
      validFrom: '2026-11-06T10:20:00.000Z',
      revokedAt: '2026-11-06T10:15:00.000Z'
    }
  }), false);
});
