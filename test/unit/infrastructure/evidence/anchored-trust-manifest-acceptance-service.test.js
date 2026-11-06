'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signTrustManifest } = require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest');
const { ExternalTrustManifestAnchorStore } = require('../../../../src/infrastructure/evidence/external-trust-manifest-anchor-store');
const { AnchoredTrustManifestAcceptanceService } = require('../../../../src/infrastructure/evidence/anchored-trust-manifest-acceptance-service');

class MemoryImmutableBackend {
  constructor() { this.objects = new Map(); }
  async putIfAbsent(key, value) {
    if (this.objects.has(key)) return { created: false, existingValue: this.objects.get(key) };
    this.objects.set(key, value);
    return { created: true };
  }
  async get(key) { return this.objects.get(key) ?? null; }
  async list(prefix) {
    return [...this.objects.entries()].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }
}

function memoryVersionStore(initial = null) {
  let state = initial;
  return {
    async read() { return state && { ...state }; },
    async compareAndSet(expected, next) {
      if (JSON.stringify(state) !== JSON.stringify(expected)) return false;
      state = { ...next };
      return true;
    },
    reset() { state = null; },
    current() { return state && { ...state }; }
  };
}

function fixture() {
  const root = crypto.generateKeyPairSync('ed25519');
  const evidence = crypto.generateKeyPairSync('ed25519');
  const rootPrivateKey = root.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rootPublicKey = root.publicKey.export({ type: 'spki', format: 'pem' });
  const evidencePublicKey = evidence.publicKey.export({ type: 'spki', format: 'pem' });
  const trustedRootKeys = { 'offline-root-1': { publicKey: rootPublicKey } };
  const backend = new MemoryImmutableBackend();
  const externalAnchorStore = new ExternalTrustManifestAnchorStore({ backend, trustedRootKeys });
  const versionStore = memoryVersionStore();
  const now = '2026-11-06T10:03:00.000Z';
  const create = version => signTrustManifest({
    version,
    issuedAt: `2026-11-06T10:0${version}:00.000Z`,
    expiresAt: `2026-12-06T10:0${version}:00.000Z`,
    keys: { 'evidence-key-1': { publicKey: evidencePublicKey } }
  }, { rootKeyId: 'offline-root-1', rootPrivateKey });
  const service = () => new AnchoredTrustManifestAcceptanceService({
    trustedRootKeys,
    versionStore,
    externalAnchorStore,
    authorize: async () => true,
    now: () => now
  });
  return { backend, externalAnchorStore, versionStore, create, service, now };
}

test('anchored acceptance restores a lost local version cache only from the exact external head', async () => {
  const f = fixture();
  const first = f.create(1);
  const second = f.create(2);
  await f.service().accept({ manifest: first, principal: { id: 'owner' } });
  await f.service().accept({ manifest: second, principal: { id: 'owner' } });
  assert.equal(f.versionStore.current().version, 2);

  f.versionStore.reset();
  await assert.rejects(
    f.service().accept({ manifest: first, principal: { id: 'owner' } }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_ROLLBACK'
  );
  const recovered = await f.service().recover({ principal: { id: 'owner' } });
  assert.equal(recovered.version, 2);
  assert.equal(recovered.recovered, true);
  assert.equal(f.versionStore.current().version, 2);
});

test('anchored acceptance requires contiguous external history and rejects cache conflicts', async () => {
  const f = fixture();
  await assert.rejects(
    f.service().accept({ manifest: f.create(2), principal: { id: 'owner' } }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_ANCHOR_GAP'
  );
  await f.service().accept({ manifest: f.create(1), principal: { id: 'owner' } });
  f.versionStore.reset();
  const state = { version: 3, digest: 'a'.repeat(64) };
  const corruptStore = memoryVersionStore(state);
  const service = new AnchoredTrustManifestAcceptanceService({
    trustedRootKeys: { 'offline-root-1': { publicKey: Object.values(f.externalAnchorStore.trustedRootKeys)[0].publicKey } },
    versionStore: corruptStore,
    externalAnchorStore: f.externalAnchorStore,
    authorize: async () => true,
    now: () => f.now
  });
  await assert.rejects(
    service.accept({ manifest: f.create(1), principal: { id: 'owner' } }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_ANCHOR_BEHIND_CACHE'
  );
});

test('anchored acceptance fails closed without authorization or independent history', async () => {
  const f = fixture();
  const denied = new AnchoredTrustManifestAcceptanceService({
    trustedRootKeys: { 'offline-root-1': { publicKey: Object.values(f.externalAnchorStore.trustedRootKeys)[0].publicKey } },
    versionStore: f.versionStore,
    externalAnchorStore: f.externalAnchorStore,
    authorize: async () => false,
    now: () => f.now
  });
  await assert.rejects(
    denied.accept({ manifest: f.create(1), principal: {} }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_FORBIDDEN'
  );
  assert.equal(f.versionStore.current(), null);
  assert.throws(() => new AnchoredTrustManifestAcceptanceService({
    trustedRootKeys: {},
    versionStore: f.versionStore,
    authorize: async () => true
  }), /independently administered immutable trust history/);
});


test('trust cache recovery works after manifest expiry without reactivating expired trust', async () => {
  const f = fixture();
  const first = f.create(1);
  await f.externalAnchorStore.append(first, { verificationTime: '2026-11-06T10:03:00.000Z' });
  const expiredNow = '2027-01-01T00:00:00.000Z';
  const service = new AnchoredTrustManifestAcceptanceService({
    trustedRootKeys: { 'offline-root-1': { publicKey: Object.values(f.externalAnchorStore.trustedRootKeys)[0].publicKey } },
    versionStore: f.versionStore,
    externalAnchorStore: f.externalAnchorStore,
    authorize: async () => true,
    now: () => expiredNow
  });
  const recovered = await service.recover({ principal: { id: 'owner' } });
  assert.equal(recovered.version, 1);
  assert.equal(f.versionStore.current().version, 1);
  await assert.rejects(
    service.accept({ manifest: first, principal: { id: 'owner' } }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_SIGNATURE_INVALID'
  );
});


test('anchored acceptance does not mutate external history when local cache is ahead', async () => {
  const f = fixture();
  const ahead = memoryVersionStore({ version: 3, digest: 'a'.repeat(64) });
  const service = new AnchoredTrustManifestAcceptanceService({
    trustedRootKeys: { 'offline-root-1': { publicKey: Object.values(f.externalAnchorStore.trustedRootKeys)[0].publicKey } },
    versionStore: ahead,
    externalAnchorStore: f.externalAnchorStore,
    authorize: async () => true,
    now: () => f.now
  });
  await assert.rejects(
    service.accept({ manifest: f.create(1), principal: { id: 'owner' } }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_ROLLBACK'
  );
  assert.equal((await f.backend.list('orient/trust-manifests/v1/')).length, 0);
});
