'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { TrustManifestAcceptanceService } = require('../../../../src/infrastructure/evidence/trust-manifest-acceptance-service');
const { signTrustManifest } = require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest');
const { ExternalTrustManifestAnchorStore } = require('../../../../src/infrastructure/evidence/external-trust-manifest-anchor-store');

function fixture() {
  const root = crypto.generateKeyPairSync('ed25519');
  const evidence = crypto.generateKeyPairSync('ed25519');
  const rootPrivateKey = root.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rootPublicKey = root.publicKey.export({ type: 'spki', format: 'pem' });
  const evidencePublicKey = evidence.publicKey.export({ type: 'spki', format: 'pem' });
  const trustedRootKeys = { root: { publicKey: rootPublicKey } };
  const manifest = signTrustManifest({
    version: 1,
    issuedAt: '2026-11-06T10:01:00.000Z',
    expiresAt: '2026-12-06T10:01:00.000Z',
    keys: { evidence: { publicKey: evidencePublicKey } }
  }, { rootKeyId: 'root', rootPrivateKey });
  const backend = {
    objects: new Map(),
    async putIfAbsent(key, value) {
      if (this.objects.has(key)) return { created: false, existingValue: this.objects.get(key) };
      this.objects.set(key, value);
      return { created: true };
    },
    async get(key) { return this.objects.get(key) ?? null; },
    async list(prefix) { return [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })); }
  };
  const externalAnchorStore = new ExternalTrustManifestAnchorStore({ backend, trustedRootKeys });
  const now = () => '2026-11-06T10:03:00.000Z';
  let state = null;
  const versionStore = {
    async read() { return state && { ...state }; },
    async compareAndSet(expected, next) {
      if (JSON.stringify(state) !== JSON.stringify(expected)) return false;
      state = { ...next };
      return true;
    }
  };
  return { manifest, trustedRootKeys, versionStore, externalAnchorStore, now };
}

test('acceptance service requires an explicit authenticated authorization boundary', () => {
  const f = fixture();
  assert.throws(() => new TrustManifestAcceptanceService({
    trustedRootKeys: f.trustedRootKeys,
    versionStore: f.versionStore,
    externalAnchorStore: f.externalAnchorStore
  }), /authorizer/);
});

test('acceptance service rejects unauthorized principals before reading trust state', async () => {
  const f = fixture();
  let reads = 0;
  const versionStore = { ...f.versionStore, async read() { reads += 1; return null; } };
  const service = new TrustManifestAcceptanceService({
    trustedRootKeys: f.trustedRootKeys,
    versionStore,
    externalAnchorStore: f.externalAnchorStore,
    now: f.now,
    authorize: async () => false
  });
  await assert.rejects(service.accept({ manifest: f.manifest, principal: { id: 'untrusted' } }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_FORBIDDEN');
  assert.equal(reads, 0);
});

test('acceptance service verifies signed manifest and returns only bounded acceptance metadata', async () => {
  const f = fixture();
  const service = new TrustManifestAcceptanceService({
    trustedRootKeys: f.trustedRootKeys,
    versionStore: f.versionStore,
    externalAnchorStore: f.externalAnchorStore,
    now: f.now,
    authorize: async (principal, action) => principal?.role === 'trust-admin' && action === 'trust-manifest.accept'
  });
  const result = await service.accept({ manifest: f.manifest, principal: { role: 'trust-admin' } });
  assert.deepEqual(result, {
    version: 1,
    digest: result.digest,
    accepted: true
  });
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await f.versionStore.read(), { version: 1, digest: result.digest });
});

test('acceptance service rejects oversized and malformed manifests', async () => {
  const f = fixture();
  const service = new TrustManifestAcceptanceService({
    trustedRootKeys: f.trustedRootKeys,
    versionStore: f.versionStore,
    externalAnchorStore: f.externalAnchorStore,
    now: f.now,
    authorize: async () => true,
    maxManifestBytes: 1024
  });
  await assert.rejects(service.accept({ manifest: { data: 'x'.repeat(2048) }, principal: {} }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_TOO_LARGE');
  await assert.rejects(service.accept({ manifest: { version: 1 }, principal: {} }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_SIGNATURE_INVALID');
});

test('acceptance service fails closed when host authorization throws', async () => {
  const f = fixture();
  const service = new TrustManifestAcceptanceService({
    trustedRootKeys: f.trustedRootKeys,
    versionStore: f.versionStore,
    externalAnchorStore: f.externalAnchorStore,
    now: f.now,
    authorize: async () => { throw new Error('identity provider unavailable'); }
  });
  await assert.rejects(service.accept({ manifest: f.manifest, principal: {} }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_AUTHORIZATION_FAILED');
});
