'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signTrustManifest, verifyTrustManifest } = require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest');
const {
  publicKeyFingerprint,
  recoveryPolicyDigest,
  signRootTransition
} = require('../../../../src/infrastructure/evidence/trusted-evidence-root-transition');
const { ExternalTrustManifestAnchorStore } = require('../../../../src/infrastructure/evidence/external-trust-manifest-anchor-store');
const { ExternalTrustRootTransitionLedger } = require('../../../../src/infrastructure/evidence/external-trust-root-transition-ledger');
const { AnchoredTrustManifestAcceptanceService } = require('../../../../src/infrastructure/evidence/anchored-trust-manifest-acceptance-service');

function pair() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

class MemoryImmutableBackend {
  constructor() { this.values = new Map(); }
  async putIfAbsent(key, value) {
    if (this.values.has(key)) return { created: false, existingValue: this.values.get(key) };
    this.values.set(key, value);
    return { created: true };
  }
  async get(key) { return this.values.get(key) ?? null; }
  async list(prefix) {
    return [...this.values.entries()].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }
}

function memoryVersionStore() {
  let state = null;
  return {
    async read() { return state && { ...state }; },
    async compareAndSet(expected, next) {
      if (JSON.stringify(state) !== JSON.stringify(expected)) return false;
      state = { ...next };
      return true;
    }
  };
}

test('manifest acceptance and root transitions share one verified external trust chronology', async () => {
  const root1 = pair();
  const root2 = pair();
  const root3 = pair();
  const recoveryKeys = [pair(), pair(), pair()];
  const evidence = pair();
  const root1Id = 'offline-root-1';
  const root2Id = 'offline-root-2';
  const root3Id = 'offline-root-3';
  const recoveryPolicy = {
    threshold: 2,
    authorities: recoveryKeys.map((key, index) => ({
      keyId: `recovery-${index + 1}`,
      publicKey: key.publicKey
    }))
  };
  const initialTrustedRoots = { [root1Id]: { publicKey: root1.publicKey } };
  const manifestBackend = new MemoryImmutableBackend();
  const transitionBackend = new MemoryImmutableBackend();
  let ledger;
  let now = '2026-11-06T10:10:00.000Z';

  const manifestStore = new ExternalTrustManifestAnchorStore({
    backend: manifestBackend,
    trustedRootKeysProvider: async () => (await ledger.readState()).trustedRootKeys
  });
  const createManifest = (version, rootKeyId, rootPrivateKey, minute) => signTrustManifest({
    version,
    issuedAt: `2026-11-06T10:${minute}:00.000Z`,
    expiresAt: `2026-12-06T10:${minute}:00.000Z`,
    keys: { 'evidence-key-1': { publicKey: evidence.publicKey } }
  }, { rootKeyId, rootPrivateKey });

  const initialManifests = [1, 2, 3, 4].map(version =>
    createManifest(version, root1Id, root1.privateKey, `0${version}`));
  for (const manifest of initialManifests) {
    await manifestStore.append(manifest, {
      verificationTime: now,
      trustedRootKeys: initialTrustedRoots
    });
  }
  const manifest4Digest = verifyTrustManifest(initialManifests[3], initialTrustedRoots).digest;
  const initialState = {
    rootEpoch: 1,
    rootKeyId: root1Id,
    rootFingerprint: publicKeyFingerprint(root1.publicKey),
    manifestHeadVersion: 4,
    manifestHeadDigest: manifest4Digest,
    transitionSequence: 0,
    transitionDigest: null,
    usedRootKeyIds: [root1Id],
    usedRootFingerprints: [publicKeyFingerprint(root1.publicKey)]
  };

  const resolveCurrentManifestHead = async ({ trustedRootKeys, expectedRootKeyId, activeFromVersion }) => {
    const head = await manifestStore.readHead({
      trustedRootKeys,
      activeRootKeyId: expectedRootKeyId,
      activeFromVersion
    });
    if (!head) return null;
    const stored = await manifestStore.getManifest(head.version, { trustedRootKeys });
    return {
      version: head.version,
      digest: head.digest,
      rootKeyId: stored.manifest.rootKeyId,
      expectedRootKeyId
    };
  };
  ledger = new ExternalTrustRootTransitionLedger({
    backend: transitionBackend,
    initialState,
    trustedRootKeys: initialTrustedRoots,
    recoveryPolicy,
    clockSkewMs: 60_000,
    maxValidityMs: 24 * 60 * 60 * 1000,
    manifestHeadProvider: resolveCurrentManifestHead,
    manifestHeadVerifier: input => manifestStore.hasAnchor(input),
    now: () => now
  });

  const makeTransition = ({
    sequence, previousDigest, previousEpoch, previousRootKeyId,
    previousRoot, nextRootKeyId, nextRoot, issuedAt, effectiveAt,
    manifestHeadVersion, manifestHeadDigest
  }) => signRootTransition({
    schemaVersion: 1,
    transitionSequence: sequence,
    previousTransitionDigest: previousDigest,
    mode: 'planned-rotation',
    previousRootEpoch: previousEpoch,
    nextRootEpoch: previousEpoch + 1,
    previousRootKeyId,
    previousRootFingerprint: publicKeyFingerprint(previousRoot.publicKey),
    nextRootKeyId,
    nextRootPublicKey: nextRoot.publicKey,
    nextRootFingerprint: publicKeyFingerprint(nextRoot.publicKey),
    manifestHeadVersion,
    manifestHeadDigest,
    issuedAt,
    effectiveAt,
    expiresAt: '2026-11-06T10:30:00.000Z',
    recoveryPolicyDigest: recoveryPolicyDigest(recoveryPolicy)
  }, {
    currentRootKeyId: previousRootKeyId,
    currentRootPrivateKey: previousRoot.privateKey,
    nextRootPrivateKey: nextRoot.privateKey
  });

  const transition1 = makeTransition({
    sequence: 1, previousDigest: null, previousEpoch: 1,
    previousRootKeyId: root1Id, previousRoot: root1,
    nextRootKeyId: root2Id, nextRoot: root2,
    issuedAt: '2026-11-06T10:05:00.000Z',
    effectiveAt: '2026-11-06T10:06:00.000Z',
    manifestHeadVersion: 4, manifestHeadDigest: manifest4Digest
  });
  await ledger.appendIfNext(transition1, null);

  const versionStore = memoryVersionStore();
  const service = new AnchoredTrustManifestAcceptanceService({
    rootTransitionLedger: ledger,
    versionStore,
    externalAnchorStore: manifestStore,
    authorize: async () => true,
    now: () => now
  });
  const manifest5 = createManifest(5, root2Id, root2.privateKey, '07');
  assert.equal((await service.accept({ manifest: manifest5, principal: { id: 'owner' } })).version, 5);
  const manifest5Digest = verifyTrustManifest(manifest5, (await ledger.readState()).trustedRootKeys).digest;

  now = '2026-11-06T10:15:00.000Z';
  const transition2 = makeTransition({
    sequence: 2,
    previousDigest: transition1.transitionDigest,
    previousEpoch: 2,
    previousRootKeyId: root2Id,
    previousRoot: root2,
    nextRootKeyId: root3Id,
    nextRoot: root3,
    issuedAt: '2026-11-06T10:11:00.000Z',
    effectiveAt: '2026-11-06T10:12:00.000Z',
    manifestHeadVersion: 5,
    manifestHeadDigest: manifest5Digest
  });
  await ledger.appendIfNext(transition2, {
    transitionSequence: 1,
    transitionDigest: transition1.transitionDigest
  });

  const manifest6 = createManifest(6, root3Id, root3.privateKey, '13');
  assert.equal((await service.accept({ manifest: manifest6, principal: { id: 'owner' } })).version, 6);
  const state = await ledger.readState();
  assert.equal(state.rootKeyId, root3Id);
  assert.equal(state.manifestHeadVersion, 5);
  assert.equal((await manifestStore.readHead({ trustedRootKeys: state.trustedRootKeys })).version, 6);
  assert.equal((await versionStore.read()).version, 6);

  const retiredManifest = createManifest(7, root2Id, root2.privateKey, '14');
  await assert.rejects(
    service.accept({ manifest: retiredManifest, principal: { id: 'owner' } }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_ROOT_NOT_ACTIVE'
  );
});
