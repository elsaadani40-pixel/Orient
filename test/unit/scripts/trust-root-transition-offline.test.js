'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  signTransitionFile,
  verifyTransitionFile,
  parseArgs
} = require('../../../scripts/trust-root-transition-offline');
const {
  publicKeyFingerprint,
  recoveryPolicyDigest
} = require('../../../src/infrastructure/evidence/trusted-evidence-root-transition');

function pair() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function fixture(t, { mode = 'planned-rotation', future = false, revokedRootAt } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-root-transition-offline-'));
  const root = pair();
  const next = pair();
  const recoveries = [pair(), pair(), pair()];
  const rootKeyPath = path.join(directory, 'root-private.pem');
  const nextKeyPath = path.join(directory, 'next-root-private.pem');
  const recoveryPaths = recoveries.map((key, index) => path.join(directory, `recovery-${index + 1}.pem`));
  fs.writeFileSync(rootKeyPath, root.privateKey, { mode: 0o600 });
  fs.writeFileSync(nextKeyPath, next.privateKey, { mode: 0o600 });
  recoveries.forEach((key, index) => fs.writeFileSync(recoveryPaths[index], key.privateKey, { mode: 0o600 }));

  const recoveryPolicy = {
    threshold: 2,
    authorities: recoveries.map((key, index) => ({
      keyId: `recovery-${index + 1}`,
      publicKey: key.publicKey
    }))
  };
  const trustedRootKeys = {
    'offline-root-1': {
      publicKey: root.publicKey,
      ...(revokedRootAt ? { revokedAt: revokedRootAt } : {})
    }
  };
  const expectedState = {
    rootEpoch: 1,
    rootKeyId: 'offline-root-1',
    rootFingerprint: publicKeyFingerprint(root.publicKey),
    manifestHeadVersion: 4,
    manifestHeadDigest: 'a'.repeat(64),
    transitionSequence: 0,
    transitionDigest: null,
    usedRootKeyIds: ['offline-root-1'],
    usedRootFingerprints: [publicKeyFingerprint(root.publicKey)]
  };
  const payload = {
    schemaVersion: 1,
    transitionSequence: 1,
    previousTransitionDigest: null,
    mode,
    previousRootEpoch: 1,
    nextRootEpoch: 2,
    previousRootKeyId: 'offline-root-1',
    previousRootFingerprint: publicKeyFingerprint(root.publicKey),
    nextRootKeyId: 'offline-root-2',
    nextRootPublicKey: next.publicKey,
    nextRootFingerprint: publicKeyFingerprint(next.publicKey),
    manifestHeadVersion: 4,
    manifestHeadDigest: 'a'.repeat(64),
    issuedAt: '2026-11-06T10:00:00.000Z',
    effectiveAt: future ? '2026-11-06T10:10:00.000Z' : '2026-11-06T10:01:00.000Z',
    expiresAt: '2026-11-06T10:30:00.000Z',
    recoveryPolicyDigest: recoveryPolicyDigest(recoveryPolicy)
  };
  const context = {
    expectedState,
    trustedRootKeys,
    recoveryPolicy,
    clockSkewMs: 60_000,
    maxValidityMs: 24 * 60 * 60 * 1000
  };
  const payloadPath = path.join(directory, 'transition-payload.json');
  const contextPath = path.join(directory, 'pinned-context.json');
  const outputPath = path.join(directory, 'signed-transition.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  fs.writeFileSync(contextPath, JSON.stringify(context));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory, root, next, recoveries, recoveryPolicy, trustedRootKeys,
    expectedState, payload, context, payloadPath, contextPath, outputPath,
    rootKeyPath, nextKeyPath, recoveryPaths
  };
}

test('offline root-transition signer signs planned rotation and verifier confirms it', t => {
  const f = fixture(t);
  const signed = signTransitionFile({
    payloadPath: f.payloadPath,
    contextPath: f.contextPath,
    nextRootKeyPath: f.nextKeyPath,
    currentRootKeyId: 'offline-root-1',
    currentRootKeyPath: f.rootKeyPath,
    outputPath: f.outputPath,
    now: () => '2026-11-06T10:05:00.000Z'
  });
  assert.equal(signed.transitionSequence, 1);
  assert.equal(signed.mode, 'planned-rotation');
  assert.equal(signed.nextRootKeyId, 'offline-root-2');
  assert.match(signed.transitionDigest, /^[a-f0-9]{64}$/);

  const verified = verifyTransitionFile({
    transitionPath: f.outputPath,
    contextPath: f.contextPath,
    now: () => '2026-11-06T10:05:00.000Z'
  });
  assert.equal(verified.transitionDigest, signed.transitionDigest);
  assert.equal(verified.verificationMode, 'current-transition-verification');
  assert.equal(verified.previousRootKeyId, 'offline-root-1');
  assert.equal(verified.nextRootKeyId, 'offline-root-2');

  assert.throws(() => signTransitionFile({
    payloadPath: f.payloadPath,
    contextPath: f.contextPath,
    nextRootKeyPath: f.nextKeyPath,
    currentRootKeyId: 'offline-root-1',
    currentRootKeyPath: f.rootKeyPath,
    outputPath: f.outputPath,
    now: () => '2026-11-06T10:05:00.000Z'
  }), error => error.code === 'TRUST_ROOT_TRANSITION_OUTPUT_EXISTS');
});

test('offline root-transition signer supports emergency recovery with independent quorum', t => {
  const f = fixture(t, {
    mode: 'emergency-recovery',
    revokedRootAt: '2026-11-06T09:00:00.000Z'
  });
  const signed = signTransitionFile({
    payloadPath: f.payloadPath,
    contextPath: f.contextPath,
    nextRootKeyPath: f.nextKeyPath,
    recoverySignerSpecs: [
      { keyId: 'recovery-1', keyPath: f.recoveryPaths[0] },
      { keyId: 'recovery-2', keyPath: f.recoveryPaths[1] }
    ],
    outputPath: f.outputPath,
    now: () => '2026-11-06T10:05:00.000Z'
  });
  assert.equal(signed.mode, 'emergency-recovery');
  assert.equal(signed.nextRootKeyId, 'offline-root-2');
  const verified = verifyTransitionFile({
    transitionPath: f.outputPath,
    contextPath: f.contextPath,
    now: () => '2026-11-06T10:05:00.000Z'
  });
  assert.equal(verified.mode, 'emergency-recovery');
});

test('offline signer rejects an insufficient recovery quorum and never writes output', t => {
  const f = fixture(t, {
    mode: 'emergency-recovery',
    revokedRootAt: '2026-11-06T09:00:00.000Z'
  });
  assert.throws(() => signTransitionFile({
    payloadPath: f.payloadPath,
    contextPath: f.contextPath,
    nextRootKeyPath: f.nextKeyPath,
    recoverySignerSpecs: [{ keyId: 'recovery-1', keyPath: f.recoveryPaths[0] }],
    outputPath: f.outputPath,
    now: () => '2026-11-06T10:05:00.000Z'
  }), error => error.code === 'TRUST_ROOT_TRANSITION_SELF_VERIFICATION_FAILED');
  assert.equal(fs.existsSync(f.outputPath), false);
});

test('offline signer self-verifies a future-effective transition without activating it', t => {
  const f = fixture(t, { future: true });
  const signed = signTransitionFile({
    payloadPath: f.payloadPath,
    contextPath: f.contextPath,
    nextRootKeyPath: f.nextKeyPath,
    currentRootKeyId: 'offline-root-1',
    currentRootKeyPath: f.rootKeyPath,
    outputPath: f.outputPath,
    now: () => '2026-11-06T10:05:00.000Z'
  });
  assert.equal(signed.verificationMode, 'future-effective-transition-self-verification');
  assert.throws(() => verifyTransitionFile({
    transitionPath: f.outputPath,
    contextPath: f.contextPath,
    now: () => '2026-11-06T10:05:00.000Z'
  }), error => error.code === 'TRUST_ROOT_TRANSITION_REJECTED');
  const historical = verifyTransitionFile({
    transitionPath: f.outputPath,
    contextPath: f.contextPath,
    historical: true
  });
  assert.equal(historical.verificationMode, 'historical-audit-only');
});

test('offline signer rejects private keys inside the repository and mismatched root authority', t => {
  const f = fixture(t);
  assert.throws(() => signTransitionFile({
    payloadPath: f.payloadPath,
    contextPath: f.contextPath,
    nextRootKeyPath: f.nextKeyPath,
    currentRootKeyId: 'not-the-payload-root',
    currentRootKeyPath: f.rootKeyPath,
    outputPath: f.outputPath,
    repoRoot: f.directory,
    now: () => '2026-11-06T10:05:00.000Z'
  }), error => error.code === 'TRUST_SIGNER_MUST_BE_OUTSIDE_REPOSITORY' ||
    error.code === 'TRUST_ROOT_TRANSITION_SELF_VERIFICATION_FAILED');
});

test('offline root-transition parser enforces command-specific arguments', () => {
  assert.deepEqual(parseArgs([
    'sign', '--payload', 'payload.json', '--context', 'context.json',
    '--next-root-key', 'next.pem', '--output', 'signed.json',
    '--current-root-key-id', 'root-1', '--current-root-key', 'root.pem'
  ]), {
    command: 'sign',
    recoverySignerSpecs: [],
    payloadPath: 'payload.json',
    contextPath: 'context.json',
    nextRootKeyPath: 'next.pem',
    outputPath: 'signed.json',
    currentRootKeyId: 'root-1',
    currentRootKeyPath: 'root.pem'
  });
  assert.deepEqual(parseArgs([
    'sign', '--payload', 'payload.json', '--context', 'context.json',
    '--next-root-key', 'next.pem', '--output', 'signed.json',
    '--recovery-signer', 'recovery-1=/secure/recovery-1.pem',
    '--recovery-signer', 'recovery-2=/secure/recovery-2.pem'
  ]).recoverySignerSpecs, [
    { keyId: 'recovery-1', keyPath: '/secure/recovery-1.pem' },
    { keyId: 'recovery-2', keyPath: '/secure/recovery-2.pem' }
  ]);
  assert.throws(() => parseArgs(['sign', '--payload', 'x']),
    error => error.code === 'TRUST_ROOT_TRANSITION_ARGUMENT_INVALID');
  assert.throws(() => parseArgs([
    'verify', '--transition', 'signed.json', '--context', 'context.json',
    '--historical', '--at', '2026-11-06T10:00:00.000Z'
  ]), error => error.code === 'TRUST_ROOT_TRANSITION_ARGUMENT_INVALID');
});
