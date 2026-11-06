'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  publicKeyFingerprint,
  recoveryPolicyDigest,
  signRootTransition,
  verifyRootTransition,
  TRANSITION_DOMAIN,
  PROOF_DOMAIN,
  DIGEST_DOMAIN
} = require('../../../../src/infrastructure/evidence/trusted-evidence-root-transition');

function pair() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function fixture() {
  const root = pair();
  const next = pair();
  const recoveries = [pair(), pair(), pair()];
  const recoveryPolicy = {
    threshold: 2,
    authorities: recoveries.map((key, index) => ({
      keyId: `recovery-${index + 1}`,
      publicKey: key.publicKey
    }))
  };
  const trustedRootKeys = { 'root-1': { publicKey: root.publicKey } };
  const expectedState = {
    rootEpoch: 1,
    rootKeyId: 'root-1',
    rootFingerprint: publicKeyFingerprint(root.publicKey),
    manifestHeadVersion: 4,
    manifestHeadDigest: 'a'.repeat(64),
    transitionSequence: 0,
    transitionDigest: null,
    usedRootKeyIds: ['root-1'],
    usedRootFingerprints: [publicKeyFingerprint(root.publicKey)]
  };
  const now = '2026-11-06T10:05:00.000Z';
  const payload = (mode = 'planned-rotation', overrides = {}) => ({
    schemaVersion: 1,
    transitionSequence: 1,
    previousTransitionDigest: null,
    mode,
    previousRootEpoch: 1,
    nextRootEpoch: 2,
    previousRootKeyId: 'root-1',
    previousRootFingerprint: expectedState.rootFingerprint,
    nextRootKeyId: 'root-2',
    nextRootPublicKey: next.publicKey,
    nextRootFingerprint: publicKeyFingerprint(next.publicKey),
    manifestHeadVersion: 4,
    manifestHeadDigest: 'a'.repeat(64),
    issuedAt: '2026-11-06T10:00:00.000Z',
    effectiveAt: '2026-11-06T10:01:00.000Z',
    expiresAt: '2026-11-06T10:30:00.000Z',
    recoveryPolicyDigest: recoveryPolicyDigest(recoveryPolicy),
    ...overrides
  });
  const verify = (envelope, options = {}) => verifyRootTransition(envelope, {
    trustedRootKeys,
    recoveryPolicy,
    expectedState,
    verificationTime: now,
    clockSkewMs: 60_000,
    maxValidityMs: 24 * 60 * 60 * 1000,
    ...options
  });
  return { root, next, recoveries, recoveryPolicy, trustedRootKeys, expectedState, now, payload, verify };
}

test('planned root rotation requires current-root authorization and next-root proof of possession', () => {
  const f = fixture();
  const envelope = signRootTransition(f.payload(), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: f.next.privateKey
  });
  const verified = f.verify(envelope);
  assert.ok(verified);
  assert.equal(verified.nextRoot.keyId, 'root-2');
  assert.equal(verified.payload.nextRootEpoch, 2);
});

test('planned rotation rejects missing old-root authorization and invalid next-root proof', () => {
  const f = fixture();
  assert.throws(() => signRootTransition(f.payload(), {
    nextRootPrivateKey: f.next.privateKey
  }), error => error.code === 'EVIDENCE_ROOT_TRANSITION_AUTHORITY_REQUIRED');

  const envelope = signRootTransition(f.payload(), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: f.next.privateKey
  });
  const wrongNext = pair();
  const forgedProof = signRootTransition(f.payload(), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: wrongNext.privateKey
  });
  assert.equal(f.verify(forgedProof), null);
  assert.notEqual(envelope.transitionDigest, forgedProof.transitionDigest);
});

test('planned rotation rejects a changed payload, stale manifest head, and reused root ID', () => {
  const f = fixture();
  const envelope = signRootTransition(f.payload(), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify({ ...envelope, payload: { ...envelope.payload, manifestHeadVersion: 5 } }), null);
  assert.equal(f.verify(envelope, {
    expectedState: { ...f.expectedState, manifestHeadDigest: 'b'.repeat(64) }
  }), null);
  assert.equal(f.verify(envelope, {
    expectedState: { ...f.expectedState, usedRootKeyIds: ['root-1', 'root-2'], usedRootFingerprints: [...f.expectedState.usedRootFingerprints, publicKeyFingerprint(f.next.publicKey)] }
  }), null);
});

test('planned rotation rejects invalid timing and transition-chain replay', () => {
  const f = fixture();
  const future = signRootTransition(f.payload('planned-rotation', {
    issuedAt: '2026-11-06T10:20:00.000Z',
    effectiveAt: '2026-11-06T10:21:00.000Z',
    expiresAt: '2026-11-06T10:30:00.000Z'
  }), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(future), null);

  const valid = signRootTransition(f.payload(), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(valid, {
    expectedState: { ...f.expectedState, transitionSequence: 1, transitionDigest: valid.transitionDigest }
  }), null);
  assert.equal(f.verify(valid, { verificationTime: '2026-11-06T10:00:00.000Z' }), null);
});

test('planned rotation rejects revoked current root and altered authorization signature', () => {
  const f = fixture();
  const envelope = signRootTransition(f.payload(), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(envelope, {
    trustedRootKeys: { 'root-1': { ...f.trustedRootKeys['root-1'], revokedAt: '2026-11-06T10:04:00.000Z' } }
  }), null);
  const altered = {
    ...envelope,
    authorizationSignatures: [{
      ...envelope.authorizationSignatures[0],
      signature: Buffer.alloc(64, 7).toString('base64')
    }]
  };
  assert.equal(f.verify(altered), null);
});

test('emergency recovery requires the configured distinct recovery threshold and new-root proof', () => {
  const f = fixture();
  const envelope = signRootTransition(f.payload('emergency-recovery'), {
    recoverySigners: f.recoveries.slice(0, 2).map((key, index) => ({
      keyId: `recovery-${index + 1}`,
      privateKey: key.privateKey
    })),
    nextRootPrivateKey: f.next.privateKey
  });
  assert.ok(f.verify(envelope));
  assert.equal(f.verify(envelope, {
    recoveryPolicy: { ...f.recoveryPolicy, threshold: 3 }
  }), null);
});

test('emergency recovery works after old-root revocation but never counts old-root signature as quorum', () => {
  const f = fixture();
  const revokedRoot = {
    'root-1': { ...f.trustedRootKeys['root-1'], revokedAt: '2026-11-06T09:00:00.000Z' }
  };
  const envelope = signRootTransition(f.payload('emergency-recovery'), {
    recoverySigners: f.recoveries.slice(0, 2).map((key, index) => ({
      keyId: `recovery-${index + 1}`,
      privateKey: key.privateKey
    })),
    nextRootPrivateKey: f.next.privateKey
  });
  assert.ok(f.verify(envelope, { trustedRootKeys: revokedRoot }));

  const belowThreshold = signRootTransition(f.payload('emergency-recovery'), {
    recoverySigners: [{ keyId: 'recovery-1', privateKey: f.recoveries[0].privateKey }],
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(belowThreshold, { trustedRootKeys: revokedRoot }), null);
});

test('emergency recovery rejects duplicate, unknown, revoked, and insufficient recovery signers', () => {
  const f = fixture();
  const oneSigner = signRootTransition(f.payload('emergency-recovery'), {
    recoverySigners: [{ keyId: 'recovery-1', privateKey: f.recoveries[0].privateKey }],
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(oneSigner), null);

  const duplicate = signRootTransition(f.payload('emergency-recovery'), {
    recoverySigners: [
      { keyId: 'recovery-1', privateKey: f.recoveries[0].privateKey },
      { keyId: 'recovery-1', privateKey: f.recoveries[0].privateKey }
    ],
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(duplicate), null);

  const unknown = signRootTransition(f.payload('emergency-recovery'), {
    recoverySigners: [
      { keyId: 'recovery-1', privateKey: f.recoveries[0].privateKey },
      { keyId: 'not-pinned', privateKey: f.recoveries[1].privateKey }
    ],
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(unknown), null);

  const revokedPolicy = {
    ...f.recoveryPolicy,
    authorities: f.recoveryPolicy.authorities.map(authority =>
      authority.keyId === 'recovery-1'
        ? { ...authority, revokedAt: '2026-11-06T09:30:00.000Z' }
        : authority)
  };
  assert.equal(f.verify(unknown, { recoveryPolicy: revokedPolicy }), null);
});

test('root transition rejects duplicate, sparse, and mismatched historical root state', () => {
  const f = fixture();
  const envelope = signRootTransition(f.payload(), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(envelope, {
    expectedState: { ...f.expectedState, usedRootKeyIds: ['root-1', 'root-1'] }
  }), null);
  const sparse = [];
  sparse.length = 1;
  assert.equal(f.verify(envelope, {
    expectedState: { ...f.expectedState, usedRootKeyIds: sparse }
  }), null);
  assert.equal(f.verify(envelope, {
    expectedState: { ...f.expectedState, usedRootFingerprints: [] }
  }), null);
});

test('root transition rejects malformed recovery policy, unsafe accessors, and invalid configuration bounds', () => {
  const f = fixture();
  assert.throws(() => recoveryPolicyDigest({ threshold: 0, authorities: [] }),
    error => error.code === 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
  assert.throws(() => recoveryPolicyDigest({ threshold: 2, authorities: [
    { keyId: 'recovery-a', publicKey: f.recoveries[0].publicKey },
    { keyId: 'recovery-b', publicKey: f.recoveries[0].publicKey }
  ] }), error => error.code === 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
  let policyGetterCalls = 0;
  const unsafePolicy = {};
  Object.defineProperties(unsafePolicy, {
    threshold: { enumerable: true, get() { policyGetterCalls += 1; return 1; } },
    authorities: { enumerable: true, value: [] }
  });
  assert.throws(() => recoveryPolicyDigest(unsafePolicy),
    error => error.code === 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
  assert.equal(policyGetterCalls, 0);
  const policyWithRevocation = {
    ...f.recoveryPolicy,
    authorities: f.recoveryPolicy.authorities.map((authority, index) =>
      index === 0 ? { ...authority, revokedAt: '2026-12-01T00:00:00.000Z' } : authority)
  };
  assert.notEqual(recoveryPolicyDigest(policyWithRevocation), recoveryPolicyDigest(f.recoveryPolicy));

  let getterCalls = 0;
  const unsafe = {};
  Object.defineProperty(unsafe, 'publicKey', {
    enumerable: true,
    get() { getterCalls += 1; return f.root.publicKey; }
  });
  const unsafeRoots = { 'root-1': unsafe };
  const envelope = signRootTransition(f.payload(), {
    currentRootKeyId: 'root-1',
    currentRootPrivateKey: f.root.privateKey,
    nextRootPrivateKey: f.next.privateKey
  });
  assert.equal(f.verify(envelope, { trustedRootKeys: unsafeRoots }), null);
  assert.equal(getterCalls, 0);
  assert.equal(f.verify(envelope, { clockSkewMs: 60 * 60 * 1000 }), null);
  assert.equal(f.verify(envelope, { maxValidityMs: 60 * 1000 }), null);
});

test('root transition signature domains are distinct and NUL terminated', () => {
  for (const domain of [TRANSITION_DOMAIN, PROOF_DOMAIN, DIGEST_DOMAIN]) {
    assert.equal(domain.endsWith('\0'), true);
  }
  assert.equal(new Set([TRANSITION_DOMAIN, PROOF_DOMAIN, DIGEST_DOMAIN]).size, 3);
});
