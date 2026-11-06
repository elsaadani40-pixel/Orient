'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readBoundedRegularFile,
  parseArgs,
  verifyManifestFile
} = require('../../../scripts/verify-trust-manifest-offline');
const { signTrustManifest } = require('../../../src/infrastructure/evidence/trusted-evidence-trust-manifest');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-offline-verifier-'));
  const rootPair = crypto.generateKeyPairSync('ed25519');
  const evidencePair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(directory, 'pinned-root.pem');
  const manifestPath = path.join(directory, 'signed-manifest.json');
  const rootPublicKey = rootPair.publicKey.export({ type: 'spki', format: 'pem' });
  const evidencePublicKey = evidencePair.publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = signTrustManifest({
    version: 1,
    issuedAt: '2026-11-06T18:59:00.000Z',
    expiresAt: '2026-12-06T18:59:00.000Z',
    keys: { 'evidence-key-1': { publicKey: evidencePublicKey } }
  }, {
    rootKeyId: 'offline-root-2026',
    rootPrivateKey: rootPair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  });
  fs.writeFileSync(publicKeyPath, rootPublicKey);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, publicKeyPath, manifestPath, manifest, rootPublicKey };
}

test('offline verifier validates a current manifest against an independently pinned root public key', t => {
  const f = fixture(t);
  const result = verifyManifestFile({
    manifestPath: f.manifestPath,
    rootKeyId: 'offline-root-2026',
    rootPublicKeyPath: f.publicKeyPath,
    now: () => '2026-11-06T19:00:00.000Z'
  });
  assert.equal(result.version, 1);
  assert.equal(result.rootKeyId, 'offline-root-2026');
  assert.equal(result.verificationMode, 'current-signature-time-verification');
  assert.equal(result.rootValidityMetadataProvided, false);
  assert.equal(result.verifiedAt, '2026-11-06T19:00:00.000Z');
  assert.equal(result.expiresAt, '2026-12-06T18:59:00.000Z');
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test('offline verifier rejects tampered manifests and unknown pinned root identifiers', t => {
  const f = fixture(t);
  const tampered = { ...f.manifest, version: 2 };
  fs.writeFileSync(f.manifestPath, JSON.stringify(tampered));
  assert.throws(() => verifyManifestFile({
    manifestPath: f.manifestPath,
    rootKeyId: 'offline-root-2026',
    rootPublicKeyPath: f.publicKeyPath,
    now: () => '2026-11-06T19:00:00.000Z'
  }), error => error.code === 'TRUST_VERIFY_MANIFEST_REJECTED');

  fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  assert.throws(() => verifyManifestFile({
    manifestPath: f.manifestPath,
    rootKeyId: 'different-root',
    rootPublicKeyPath: f.publicKeyPath,
    now: () => '2026-11-06T19:00:00.000Z'
  }), error => error.code === 'TRUST_VERIFY_MANIFEST_REJECTED');
});

test('offline verifier distinguishes expired current acceptance from historical audit verification', t => {
  const f = fixture(t);
  assert.throws(() => verifyManifestFile({
    manifestPath: f.manifestPath,
    rootKeyId: 'offline-root-2026',
    rootPublicKeyPath: f.publicKeyPath,
    now: () => '2027-01-01T00:00:00.000Z'
  }), error => error.code === 'TRUST_VERIFY_MANIFEST_REJECTED');

  const historical = verifyManifestFile({
    manifestPath: f.manifestPath,
    rootKeyId: 'offline-root-2026',
    rootPublicKeyPath: f.publicKeyPath,
    historical: true
  });
  assert.equal(historical.verificationMode, 'historical-audit-only');
  assert.equal(Object.hasOwn(historical, 'verifiedAt'), false);
  assert.equal(historical.version, 1);
});

test('offline verifier enforces supplied pinned-root validity and revocation metadata', t => {
  const f = fixture(t);
  assert.throws(() => verifyManifestFile({
    manifestPath: f.manifestPath,
    rootKeyId: 'offline-root-2026',
    rootPublicKeyPath: f.publicKeyPath,
    rootValidFrom: '2026-11-06T18:00:00.000Z',
    rootRevokedAt: '2026-11-06T19:00:00.000Z',
    now: () => '2026-11-06T19:00:00.000Z'
  }), error => error.code === 'TRUST_VERIFY_MANIFEST_REJECTED');

  const historical = verifyManifestFile({
    manifestPath: f.manifestPath,
    rootKeyId: 'offline-root-2026',
    rootPublicKeyPath: f.publicKeyPath,
    rootValidFrom: '2026-11-06T18:00:00.000Z',
    rootRevokedAt: '2026-11-06T19:00:00.000Z',
    historical: true
  });
  assert.equal(historical.verificationMode, 'historical-audit-only');
});
test('offline verifier rejects non-Ed25519 pinned root keys', t => {
  const f = fixture(t);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(f.publicKeyPath, rsa.publicKey.export({ type: 'spki', format: 'pem' }));
  assert.throws(() => verifyManifestFile({
    manifestPath: f.manifestPath,
    rootKeyId: 'offline-root-2026',
    rootPublicKeyPath: f.publicKeyPath,
    now: () => '2026-11-06T19:00:00.000Z'
  }), error => error.code === 'TRUST_VERIFY_ROOT_KEY_TYPE_INVALID');
});

test('offline verifier rejects symlink and oversized input files', t => {
  const f = fixture(t);
  const link = path.join(f.directory, 'manifest-link.json');
  fs.symlinkSync(f.manifestPath, link);
  assert.throws(() => readBoundedRegularFile(link, 1024, 'TRUST_VERIFY_MANIFEST'),
    error => error.code === 'TRUST_VERIFY_MANIFEST_FILE_INVALID');

  const oversized = path.join(f.directory, 'oversized.bin');
  fs.writeFileSync(oversized, '12345');
  assert.throws(() => readBoundedRegularFile(oversized, 4, 'TRUST_VERIFY_INPUT'),
    error => error.code === 'TRUST_VERIFY_INPUT_FILE_INVALID');
});

test('offline verifier argument parser rejects duplicate, unknown, and conflicting modes', () => {
  assert.deepEqual(parseArgs([
    '--manifest', 'signed.json',
    '--root-key-id', 'offline-root-2026',
    '--root-public-key', 'root.pem',
    '--root-valid-from', '2026-11-06T18:00:00.000Z',
    '--root-revoked-at', '2026-11-06T19:00:00.000Z',
    '--historical'
  ]), {
    manifestPath: 'signed.json',
    rootKeyId: 'offline-root-2026',
    rootPublicKeyPath: 'root.pem',
    rootValidFrom: '2026-11-06T18:00:00.000Z',
    rootRevokedAt: '2026-11-06T19:00:00.000Z',
    historical: true
  });
  assert.throws(() => parseArgs([
    '--manifest', 'signed.json',
    '--root-key-id', 'offline-root-2026',
    '--root-public-key', 'root.pem',
    '--historical', '--at', '2026-11-06T19:00:00.000Z'
  ]), error => error.code === 'TRUST_VERIFY_ARGUMENT_INVALID');
  assert.throws(() => parseArgs([
    '--manifest', 'signed.json',
    '--root-key-id', 'offline-root-2026',
    '--root-public-key', 'root.pem',
    '--unknown', 'x'
  ]), error => error.code === 'TRUST_VERIFY_ARGUMENT_INVALID');
});
