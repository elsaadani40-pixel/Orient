'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonicalJson } = require('../../../../src/core/execution/evidence-record');
const { signTrustManifest } = require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest');
const {
  ExternalTrustManifestAnchorStore,
  manifestKey
} = require('../../../../src/infrastructure/evidence/external-trust-manifest-anchor-store');

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

function fixture() {
  const root = crypto.generateKeyPairSync('ed25519');
  const evidence = crypto.generateKeyPairSync('ed25519');
  const rootPrivateKey = root.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rootPublicKey = root.publicKey.export({ type: 'spki', format: 'pem' });
  const evidencePublicKey = evidence.publicKey.export({ type: 'spki', format: 'pem' });
  const trustedRootKeys = { 'offline-root-1': { publicKey: rootPublicKey } };
  const backend = new MemoryImmutableBackend();
  const store = new ExternalTrustManifestAnchorStore({ backend, trustedRootKeys });
  const create = version => signTrustManifest({
    version,
    issuedAt: `2026-11-06T10:0${version}:00.000Z`,
    expiresAt: `2026-12-06T10:0${version}:00.000Z`,
    keys: { 'evidence-key-1': { publicKey: evidencePublicKey } }
  }, { rootKeyId: 'offline-root-1', rootPrivateKey });
  return { backend, store, create, trustedRootKeys };
}

test('external trust anchor store preserves signed manifest history across adapter restart', async () => {
  const f = fixture();
  const first = f.create(1);
  const second = f.create(2);
  assert.equal((await f.store.append(first, { verificationTime: '2026-11-06T10:03:00.000Z' })).created, true);
  assert.equal((await f.store.append(second, { verificationTime: '2026-11-06T10:03:00.000Z' })).created, true);

  const restarted = new ExternalTrustManifestAnchorStore({
    backend: f.backend,
    trustedRootKeys: f.trustedRootKeys
  });
  assert.deepEqual(await restarted.readHead(), {
    version: 2,
    digest: require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest')
      .verifyTrustManifest(second, f.trustedRootKeys).digest
  });
});

test('external trust anchor store makes exact retries idempotent and rejects old manifests', async () => {
  const f = fixture();
  const first = f.create(1);
  const second = f.create(2);
  await f.store.append(first, { verificationTime: '2026-11-06T10:03:00.000Z' });
  await f.store.append(second, { verificationTime: '2026-11-06T10:03:00.000Z' });
  assert.equal((await f.store.append(second, { verificationTime: '2026-11-06T10:03:00.000Z' })).created, false);
  await assert.rejects(
    f.store.append(first, { verificationTime: '2026-11-06T10:03:00.000Z' }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_ROLLBACK'
  );
});

test('external trust anchor store rejects gaps, tampered entries, and noncanonical bytes', async () => {
  const f = fixture();
  const second = f.create(2);
  f.backend.objects.set(manifestKey(2), canonicalJson(second));
  await assert.rejects(f.store.readHead(), error => error.code === 'EVIDENCE_TRUST_MANIFEST_ANCHOR_GAP');

  f.backend.objects.clear();
  const first = f.create(1);
  f.backend.objects.set(manifestKey(1), canonicalJson({ ...first, version: 2 }));
  await assert.rejects(f.store.readHead(), error => error.code === 'EVIDENCE_TRUST_MANIFEST_ANCHOR_CORRUPT');

  f.backend.objects.set(manifestKey(1), JSON.stringify(first, null, 2));
  await assert.rejects(f.store.readHead(), error => error.code === 'EVIDENCE_TRUST_MANIFEST_ANCHOR_CORRUPT');
});

test('external trust anchor store rejects conflicting same-version immutable content', async () => {
  const f = fixture();
  const first = f.create(1);
  await f.store.append(first, { verificationTime: '2026-11-06T10:03:00.000Z' });
  const conflicting = require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest')
    .signTrustManifest({
      version: 1,
      issuedAt: '2026-11-06T10:02:00.000Z',
      expiresAt: '2026-12-06T10:02:00.000Z',
      keys: first.keys
    }, { rootKeyId: 'offline-root-1', rootPrivateKey: f.rootPrivateKey });
  await assert.rejects(
    f.store.append(conflicting, { verificationTime: '2026-11-06T10:03:00.000Z' }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_VERSION_CONFLICT'
  );
});

test('external trust anchor store fails closed on incomplete backend contracts', async () => {
  assert.throws(
    () => new ExternalTrustManifestAnchorStore({ backend: { get() {} }, trustedRootKeys: {} }),
    /immutable external trust-manifest backend/
  );
  const f = fixture();
  f.backend.list = async () => null;
  await assert.rejects(
    f.store.readHead(),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_ANCHOR_CONTRACT_INVALID'
  );
});
