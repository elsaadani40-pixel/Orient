'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  signManifestFile,
  readPrivateKeyFile,
  parseArgs,
  MAX_PRIVATE_KEY_BYTES,
  MAX_MANIFEST_BYTES
} = require('../../../scripts/sign-trust-manifest-offline');
const { verifyTrustManifest } = require('../../../src/infrastructure/evidence/trusted-evidence-trust-manifest');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-offline-signer-'));
  const repoRoot = path.join(root, 'repo');
  const offlineDir = path.join(root, 'offline');
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(offlineDir);
  fs.mkdirSync(outputDir);

  const rootPair = crypto.generateKeyPairSync('ed25519');
  const evidencePair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = rootPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = rootPair.publicKey.export({ type: 'spki', format: 'pem' });
  const evidencePublicKeyPem = evidencePair.publicKey.export({ type: 'spki', format: 'pem' });
  const keyPath = path.join(offlineDir, 'offline-root.pem');
  const inputPath = path.join(root, 'manifest.json');
  const outputPath = path.join(outputDir, 'signed-manifest.json');
  const now = '2026-11-06T19:00:00.000Z';

  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(inputPath, JSON.stringify({
    version: 1,
    issuedAt: '2026-11-06T18:59:00.000Z',
    expiresAt: '2026-12-06T18:59:00.000Z',
    keys: {
      'evidence-key-1': {
        publicKey: evidencePublicKeyPem,
        validFrom: '2026-11-06T18:00:00.000Z'
      }
    }
  }));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, repoRoot, offlineDir, keyPath, inputPath, outputPath, now,
    publicKeyPem, privateKeyPem
  };
}

test('offline signer creates and locally verifies a root-signed manifest without exposing key material', t => {
  const f = fixture(t);
  const result = signManifestFile({
    inputPath: f.inputPath,
    keyPath: f.keyPath,
    rootKeyId: 'offline-root-2026',
    outputPath: f.outputPath,
    repoRoot: f.repoRoot,
    now: () => f.now
  });

  const signed = JSON.parse(fs.readFileSync(f.outputPath, 'utf8'));
  const verified = verifyTrustManifest(signed, {
    'offline-root-2026': { publicKey: f.publicKeyPem }
  }, { verificationTime: f.now });

  assert.equal(result.version, 1);
  assert.equal(result.outputPath, f.outputPath);
  assert.equal(verified.version, 1);
  assert.equal(result.digest, verified.digest);
  assert.equal(JSON.stringify(signed).includes(f.privateKeyPem), false);
});

test('offline signer rejects manifest input symlinks', t => {
  const f = fixture(t);
  const linkPath = path.join(f.root, 'manifest-link.json');
  fs.symlinkSync(f.inputPath, linkPath);
  assert.throws(() => signManifestFile({
    inputPath: linkPath,
    keyPath: f.keyPath,
    rootKeyId: 'offline-root-2026',
    outputPath: f.outputPath,
    repoRoot: f.repoRoot,
    now: () => f.now
  }), error => ['TRUST_SIGNER_INPUT_INVALID', 'TRUST_SIGNER_INPUT_UNSAFE_FILESYSTEM'].includes(error.code));
});

test('offline signer rejects manifest input above the bounded read limit', t => {
  const f = fixture(t);
  fs.writeFileSync(f.inputPath, Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20));
  assert.throws(() => signManifestFile({
    inputPath: f.inputPath,
    keyPath: f.keyPath,
    rootKeyId: 'offline-root-2026',
    outputPath: f.outputPath,
    repoRoot: f.repoRoot,
    now: () => f.now
  }), error => error.code === 'TRUST_SIGNER_INPUT_INVALID');
});

test('offline signer detects same-size manifest mutation during bounded read', t => {
  const f = fixture(t);
  const originalReadSync = fs.readSync;
  let changed = false;
  fs.readSync = function (...args) {
    const count = originalReadSync.apply(this, args);
    if (count > 0 && !changed) {
      changed = true;
      const current = fs.readFileSync(f.inputPath, 'utf8');
      fs.writeFileSync(f.inputPath, current.replace('"version":1', '"version":2'));
    }
    return count;
  };
  try {
    assert.throws(() => signManifestFile({
      inputPath: f.inputPath,
      keyPath: f.keyPath,
      rootKeyId: 'offline-root-2026',
      outputPath: f.outputPath,
      repoRoot: f.repoRoot,
      now: () => f.now
    }), error => error.code === 'TRUST_SIGNER_INPUT_INVALID');
  } finally {
    fs.readSync = originalReadSync;
  }
});

test('offline signer refuses to overwrite an existing signed manifest', t => {
  const f = fixture(t);
  fs.writeFileSync(f.outputPath, 'preserve-existing-output');
  assert.throws(() => signManifestFile({
    inputPath: f.inputPath,
    keyPath: f.keyPath,
    rootKeyId: 'offline-root-2026',
    outputPath: f.outputPath,
    repoRoot: f.repoRoot,
    now: () => f.now
  }), error => error.code === 'TRUST_SIGNER_OUTPUT_EXISTS');
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'preserve-existing-output');
});

test('offline signer rejects private keys stored inside the repository', t => {
  const f = fixture(t);
  const inRepoKey = path.join(f.repoRoot, 'private.pem');
  fs.writeFileSync(inRepoKey, f.privateKeyPem, { mode: 0o600 });
  assert.throws(() => readPrivateKeyFile(inRepoKey, { repoRoot: f.repoRoot }),
    error => error.code === 'TRUST_SIGNER_KEY_MUST_BE_OUTSIDE_REPOSITORY');
});

test('offline signer rejects group-readable or world-readable private-key files', t => {
  const f = fixture(t);
  fs.chmodSync(f.keyPath, 0o644);
  assert.throws(() => readPrivateKeyFile(f.keyPath, { repoRoot: f.repoRoot, platform: 'linux' }),
    error => error.code === 'TRUST_SIGNER_KEY_PERMISSIONS_INVALID');
});

test('offline signer rejects symlink private-key paths', t => {
  const f = fixture(t);
  const linkPath = path.join(f.offlineDir, 'root-link.pem');
  fs.symlinkSync(f.keyPath, linkPath);
  assert.throws(() => readPrivateKeyFile(linkPath, { repoRoot: f.repoRoot, platform: 'linux' }),
    error => ['TRUST_SIGNER_KEY_FILE_INVALID', 'TRUST_SIGNER_KEY_UNSAFE_FILESYSTEM'].includes(error.code));
});

test('offline signer argument parser rejects unknown, duplicate, and incomplete flags', () => {
  assert.throws(() => parseArgs(['--input', 'in.json', '--key', 'root.pem', '--root-key-id', 'root', '--output', 'out.json', '--extra', 'x']),
    error => error.code === 'TRUST_SIGNER_ARGUMENT_INVALID');
  assert.throws(() => parseArgs(['--input', 'in.json', '--input', 'again.json', '--key', 'root.pem', '--root-key-id', 'root', '--output', 'out.json']),
    error => error.code === 'TRUST_SIGNER_ARGUMENT_INVALID');
  assert.throws(() => parseArgs(['--input', 'in.json']),
    error => error.code === 'TRUST_SIGNER_ARGUMENT_INVALID');
});


test('offline signer rejects private-key files above the bounded read limit', t => {
  const f = fixture(t);
  fs.writeFileSync(f.keyPath, Buffer.alloc(MAX_PRIVATE_KEY_BYTES + 1, 0x41), { mode: 0o600 });
  assert.throws(() => readPrivateKeyFile(f.keyPath, { repoRoot: f.repoRoot }),
    error => error.code === 'TRUST_SIGNER_KEY_FILE_INVALID');
});

test('offline signer rejects private keys with additional hard links', t => {
  const f = fixture(t);
  const inRepoLink = path.join(f.repoRoot, 'private-hardlink.pem');
  fs.linkSync(f.keyPath, inRepoLink);
  assert.throws(() => readPrivateKeyFile(f.keyPath, { repoRoot: f.repoRoot }),
    error => error.code === 'TRUST_SIGNER_KEY_FILE_INVALID');
});


test('offline signer detects same-size private-key mutation during bounded read', t => {
  const f = fixture(t);
  const originalReadSync = fs.readSync;
  let changed = false;
  fs.readSync = function (...args) {
    const count = originalReadSync.apply(this, args);
    if (count > 0 && !changed) {
      changed = true;
      const replacement = Buffer.from(f.privateKeyPem);
      const index = replacement.indexOf(0x41);
      replacement[index] = 0x42;
      fs.writeFileSync(f.keyPath, replacement, { mode: 0o600 });
    }
    return count;
  };
  try {
    assert.throws(
      () => readPrivateKeyFile(f.keyPath, { repoRoot: f.repoRoot, platform: 'linux' }),
      error => error.code === 'TRUST_SIGNER_KEY_FILE_INVALID'
    );
    assert.equal(changed, true);
  } finally {
    fs.readSync = originalReadSync;
  }
});
