'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  publicKeyFingerprint,
  recoveryPolicyDigest,
  signRootTransition
} = require('../../../../src/infrastructure/evidence/trusted-evidence-root-transition');
const {
  ExternalTrustRootTransitionLedger,
  PREFIX,
  keyForSequence
} = require('../../../../src/infrastructure/evidence/external-trust-root-transition-ledger');

function pair() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

class MemoryBackend {
  constructor() { this.values = new Map(); }
  async putIfAbsent(key, value) {
    if (this.values.has(key)) return { created: false, existingValue: this.values.get(key) };
    this.values.set(key, value);
    return { created: true };
  }
  async get(key) { return this.values.get(key) ?? null; }
  async list(prefix) {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }
}

function fixture({ revokedRootAt } = {}) {
  const root = pair();
  const next = pair();
  const third = pair();
  const recoveries = [pair(), pair(), pair()];
  const recoveryPolicy = {
    threshold: 2,
    authorities: recoveries.map((key, index) => ({
      keyId: `recovery-${index + 1}`,
      publicKey: key.publicKey
    }))
  };
  const initialState = {
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
  const trustedRootKeys = {
    'root-1': {
      publicKey: root.publicKey,
      ...(revokedRootAt ? { revokedAt: revokedRootAt } : {})
    }
  };
  const backend = new MemoryBackend();
  let now = '2026-11-06T10:05:00.000Z';
  const ledger = new ExternalTrustRootTransitionLedger({
    backend, initialState, trustedRootKeys, recoveryPolicy,
    clockSkewMs: 60_000,
    maxValidityMs: 24 * 60 * 60 * 1000,
    now: () => now
  });
  const payload = ({
    sequence = 1, previousDigest = null, previousEpoch = 1,
    previousRootKeyId = 'root-1',
    previousRootFingerprint = initialState.rootFingerprint,
    nextRoot = next, nextRootKeyId = 'root-2',
    issuedAt = '2026-11-06T10:00:00.000Z',
    effectiveAt = '2026-11-06T10:01:00.000Z',
    expiresAt = '2026-11-06T10:30:00.000Z',
    mode = 'planned-rotation'
  } = {}) => ({
    schemaVersion: 1,
    transitionSequence: sequence,
    previousTransitionDigest: previousDigest,
    mode,
    previousRootEpoch: previousEpoch,
    nextRootEpoch: previousEpoch + 1,
    previousRootKeyId,
    previousRootFingerprint,
    nextRootKeyId,
    nextRootPublicKey: nextRoot.publicKey,
    nextRootFingerprint: publicKeyFingerprint(nextRoot.publicKey),
    manifestHeadVersion: 4,
    manifestHeadDigest: 'a'.repeat(64),
    issuedAt, effectiveAt, expiresAt,
    recoveryPolicyDigest: recoveryPolicyDigest(recoveryPolicy)
  });
  const planned = (input, signingRoot = root, nextSigning = next) =>
    signRootTransition(payload(input), {
      currentRootKeyId: input.previousRootKeyId || 'root-1',
      currentRootPrivateKey: signingRoot.privateKey,
      nextRootPrivateKey: nextSigning.privateKey
    });
  const emergency = (input, nextSigning = next) =>
    signRootTransition(payload({ ...input, mode: 'emergency-recovery' }), {
      recoverySigners: recoveries.slice(0, 2).map((key, index) => ({
        keyId: `recovery-${index + 1}`, privateKey: key.privateKey
      })),
      nextRootPrivateKey: nextSigning.privateKey
    });
  return {
    root, next, third, recoveries, recoveryPolicy, initialState, trustedRootKeys,
    backend, ledger, payload, planned, emergency,
    setNow(value) { now = value; }
  };
}

test('ledger appends a planned transition conditionally and reconstructs the active root', async () => {
  const f = fixture();
  const envelope = f.planned({});
  const result = await f.ledger.appendIfNext(envelope, null);
  assert.deepEqual(result, {
    created: true,
    transitionSequence: 1,
    transitionDigest: envelope.transitionDigest
  });
  const state = await f.ledger.readState();
  assert.equal(state.rootEpoch, 2);
  assert.equal(state.rootKeyId, 'root-2');
  assert.equal(state.rootFingerprint, publicKeyFingerprint(f.next.publicKey));
  assert.equal(state.transitionSequence, 1);
  assert.equal(state.verifiedTransitionCount, 1);
  assert.equal(state.activeRoot.publicKey, f.next.publicKey);
  assert.equal(state.usedRootKeyIds.includes('root-1'), true);
  assert.equal(state.usedRootFingerprints.includes(publicKeyFingerprint(f.root.publicKey)), true);
});

test('ledger rejects stale heads and conflicting sequence content', async () => {
  const f = fixture();
  const first = f.planned({});
  await f.ledger.appendIfNext(first, null);
  const retry = await f.ledger.appendIfNext(first, null);
  assert.equal(retry.created, false);
  assert.equal(retry.transitionDigest, first.transitionDigest);
  const conflicting = f.planned({ nextRootKeyId: 'root-alt', nextRoot: f.third });
  await assert.rejects(
    () => f.ledger.appendIfNext(conflicting, { transitionSequence: 1, transitionDigest: first.transitionDigest }),
    error => error.code === 'EVIDENCE_ROOT_TRANSITION_LEDGER_CONFLICT'
  );
});

test('ledger replays expired historical transitions but never accepts them as new transitions', async () => {
  const f = fixture();
  const envelope = f.planned({});
  await f.ledger.appendIfNext(envelope, null);
  f.setNow('2026-12-01T00:00:00.000Z');
  const state = await f.ledger.readState();
  assert.equal(state.rootKeyId, 'root-2');
  assert.equal(state.transitionDigest, envelope.transitionDigest);
  const other = signRootTransition(f.payload({
    sequence: 2, previousDigest: envelope.transitionDigest, previousEpoch: 2,
    previousRootKeyId: 'root-2',
    previousRootFingerprint: publicKeyFingerprint(f.next.publicKey),
    nextRoot: f.third, nextRootKeyId: 'root-3'
  }), {
    currentRootKeyId: 'root-2',
    currentRootPrivateKey: f.next.privateKey,
    nextRootPrivateKey: f.third.privateKey
  });
  await assert.rejects(
    () => f.ledger.appendIfNext(other, {
      transitionSequence: 1, transitionDigest: envelope.transitionDigest
    }),
    error => error.code === 'EVIDENCE_ROOT_TRANSITION_INVALID'
  );
});

test('ledger supports sequential rotations and exact idempotent append retry', async () => {
  const f = fixture();
  const first = f.planned({});
  await f.ledger.appendIfNext(first, null);
  const secondPayload = f.payload({
    sequence: 2, previousDigest: first.transitionDigest, previousEpoch: 2,
    previousRootKeyId: 'root-2',
    previousRootFingerprint: publicKeyFingerprint(f.next.publicKey),
    nextRoot: f.third, nextRootKeyId: 'root-3'
  });
  const second = signRootTransition(secondPayload, {
    currentRootKeyId: 'root-2',
    currentRootPrivateKey: f.next.privateKey,
    nextRootPrivateKey: f.third.privateKey
  });
  const head = { transitionSequence: 1, transitionDigest: first.transitionDigest };
  const result = await f.ledger.appendIfNext(second, head);
  assert.equal(result.created, true);
  assert.equal(result.transitionSequence, 2);
  const state = await f.ledger.readState();
  assert.equal(state.rootEpoch, 3);
  assert.equal(state.rootKeyId, 'root-3');
  assert.deepEqual(state.usedRootKeyIds, ['root-1', 'root-2', 'root-3']);
  const retry = await f.ledger.appendIfNext(second, head);
  assert.equal(retry.created, false);
  assert.equal(retry.transitionDigest, second.transitionDigest);
});

test('emergency recovery uses independent quorum when the previous root is already revoked', async () => {
  const f = fixture({ revokedRootAt: '2026-11-06T09:00:00.000Z' });
  const envelope = f.emergency({
    issuedAt: '2026-11-06T10:00:00.000Z',
    effectiveAt: '2026-11-06T10:01:00.000Z'
  });
  const result = await f.ledger.appendIfNext(envelope, null);
  assert.equal(result.created, true);
  const state = await f.ledger.readState();
  assert.equal(state.rootKeyId, 'root-2');
});

test('ledger rejects gaps and tampered stored envelopes', async () => {
  const f = fixture();
  const envelope = f.planned({});
  f.backend.values.set(keyForSequence(2), JSON.stringify(envelope));
  await assert.rejects(
    () => f.ledger.readHistory(),
    error => error.code === 'EVIDENCE_ROOT_TRANSITION_LEDGER_CORRUPT' ||
      error.code === 'EVIDENCE_ROOT_TRANSITION_LEDGER_GAP'
  );
  f.backend.values.clear();
  f.backend.values.set(keyForSequence(1),
    JSON.stringify({ ...envelope, transitionDigest: 'f'.repeat(64) }));
  await assert.rejects(
    () => f.ledger.readHistory(),
    error => error.code === 'EVIDENCE_ROOT_TRANSITION_LEDGER_INVALID'
  );
});

test('ledger bootstrap rejects unpinned or incomplete root history', () => {
  const f = fixture();
  assert.throws(() => new ExternalTrustRootTransitionLedger({
    backend: f.backend,
    initialState: { ...f.initialState, usedRootKeyIds: [] },
    trustedRootKeys: f.trustedRootKeys,
    recoveryPolicy: f.recoveryPolicy,
    clockSkewMs: 60_000,
    maxValidityMs: 24 * 60 * 60 * 1000
  }), /complete pinned root-transition bootstrap state|exactly the initial root ID and fingerprint/);
});

test('ledger namespace is versioned and sequence keys are fixed width', () => {
  assert.equal(PREFIX, 'orient/trust-root-transitions/v1/');
  assert.equal(keyForSequence(7), 'orient/trust-root-transitions/v1/0000000000000007.json');
  assert.throws(() => keyForSequence(0), error => error.code === 'EVIDENCE_ROOT_TRANSITION_LEDGER_INVALID');
});
