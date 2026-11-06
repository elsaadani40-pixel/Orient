'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyTrustManifest } = require('../src/infrastructure/evidence/trusted-evidence-trust-manifest');

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;
const USAGE = 'Usage: node scripts/verify-trust-manifest-offline.js --manifest <signed-manifest.json> --root-key-id <id> --root-public-key <pinned-root-public.pem> [--root-valid-from <canonical-utc-time>] [--root-revoked-at <canonical-utc-time>] [--at <canonical-utc-time> | --historical]';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function readBoundedRegularFile(filePath, maxBytes, codePrefix) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    fail(codePrefix + '_PATH_REQUIRED', 'A file path is required');
  }

  const absolutePath = path.resolve(filePath);
  let descriptor;
  try {
    const before = fs.lstatSync(absolutePath);
    if (before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > maxBytes) {
      fail(codePrefix + '_FILE_INVALID', 'Input must be a regular non-symlink file within the configured size limit');
    }
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
    const after = fs.fstatSync(descriptor);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.size < 1 || after.size > maxBytes) {
      fail(codePrefix + '_FILE_CHANGED', 'Input file changed while it was being opened');
    }

    // Bound allocation and reading, then verify the opened inode again after
    // EOF. A file can grow or be modified after the initial fstat().
    const buffer = Buffer.alloc(maxBytes + 1);
    try {
      let total = 0;
      while (total < buffer.length) {
        const read = fs.readSync(descriptor, buffer, total,
          Math.min(64 * 1024, buffer.length - total), null);
        if (read === 0) break;
        total += read;
      }
      const afterRead = fs.fstatSync(descriptor);
      if (total < 1 || total > maxBytes || afterRead.size !== total ||
          afterRead.dev !== before.dev || afterRead.ino !== before.ino ||
          afterRead.nlink !== after.nlink) {
        fail(codePrefix + '_FILE_CHANGED', 'Input file changed or exceeded its size limit while being read');
      }
      return Buffer.from(buffer.subarray(0, total));
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    if (error && error.code && error.code.startsWith(codePrefix + '_')) throw error;
    fail(codePrefix + '_FILE_UNREADABLE', 'Unable to safely read input file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readManifest(filePath) {
  const bytes = readBoundedRegularFile(filePath, MAX_MANIFEST_BYTES, 'TRUST_VERIFY_MANIFEST');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('TRUST_VERIFY_MANIFEST_INVALID', 'Signed manifest input must contain valid JSON');
  } finally {
    bytes.fill(0);
  }
}

function readRootPublicKey(filePath) {
  const bytes = readBoundedRegularFile(filePath, MAX_PUBLIC_KEY_BYTES, 'TRUST_VERIFY_ROOT_KEY');
  try {
    let publicKey;
    try {
      publicKey = crypto.createPublicKey(bytes);
    } catch {
      fail('TRUST_VERIFY_ROOT_KEY_INVALID', 'Unable to parse the pinned root public key');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      fail('TRUST_VERIFY_ROOT_KEY_TYPE_INVALID', 'Pinned trust root public key must be Ed25519');
    }
    return publicKey.export({ type: 'spki', format: 'pem' });
  } finally {
    bytes.fill(0);
  }
}

function parseArgs(argv) {
  const mapping = {
    '--manifest': 'manifestPath',
    '--root-key-id': 'rootKeyId',
    '--root-public-key': 'rootPublicKeyPath',
    '--root-valid-from': 'rootValidFrom',
    '--root-revoked-at': 'rootRevokedAt',
    '--at': 'verificationTime'
  };
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--historical') {
      if (options.historical === true || options.verificationTime !== undefined) {
        fail('TRUST_VERIFY_ARGUMENT_INVALID', USAGE);
      }
      options.historical = true;
      continue;
    }
    const property = mapping[flag];
    if (!property || Object.prototype.hasOwnProperty.call(options, property)) {
      fail('TRUST_VERIFY_ARGUMENT_INVALID', USAGE);
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      fail('TRUST_VERIFY_ARGUMENT_INVALID', USAGE);
    }
    options[property] = value;
    index += 1;
  }
  if (typeof options.manifestPath !== 'string' ||
      typeof options.rootKeyId !== 'string' ||
      typeof options.rootPublicKeyPath !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.rootKeyId)) {
    fail('TRUST_VERIFY_ARGUMENT_INVALID', USAGE);
  }
  if (options.historical && options.verificationTime !== undefined) {
    fail('TRUST_VERIFY_ARGUMENT_INVALID', USAGE);
  }
  return options;
}

function verifyManifestFile({
  manifestPath,
  rootKeyId,
  rootPublicKeyPath,
  rootValidFrom,
  rootRevokedAt,
  verificationTime,
  historical = false,
  now = () => new Date().toISOString()
} = {}) {
  if (typeof rootKeyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rootKeyId)) {
    fail('TRUST_VERIFY_ROOT_KEY_ID_INVALID', 'A valid pinned root key identifier is required');
  }
  if (historical !== true && verificationTime !== undefined && typeof verificationTime !== 'string') {
    fail('TRUST_VERIFY_TIME_INVALID', 'Verification time must be a canonical UTC timestamp');
  }
  const manifest = readManifest(manifestPath);
  const publicKey = readRootPublicKey(rootPublicKeyPath);
  const rootEntry = {
    publicKey,
    ...(rootValidFrom === undefined ? {} : { validFrom: rootValidFrom }),
    ...(rootRevokedAt === undefined ? {} : { revokedAt: rootRevokedAt })
  };
  const roots = { [rootKeyId]: rootEntry };
  const rootPublicKeySha256 = crypto.createHash('sha256')
    .update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
    .digest('hex');
  const rootValidityMetadataProvided = rootValidFrom !== undefined || rootRevokedAt !== undefined;
  const effectiveVerificationTime = historical
    ? undefined
    : verificationTime === undefined ? now() : verificationTime;
  const verified = historical
    ? verifyTrustManifest(manifest, roots)
    : verifyTrustManifest(manifest, roots, { verificationTime: effectiveVerificationTime });
  if (!verified) {
    fail('TRUST_VERIFY_MANIFEST_REJECTED', historical
      ? 'Manifest failed historical signature or payload verification'
      : 'Manifest is not currently valid or failed signature and payload verification');
  }
  return Object.freeze({
    version: verified.version,
    digest: verified.digest,
    rootKeyId,
    rootPublicKeySha256,
    issuedAt: verified.issuedAt,
    expiresAt: verified.expiresAt,
    verificationMode: historical ? 'historical-audit-only'
      : verificationTime === undefined
        ? rootValidityMetadataProvided ? 'current-pinned-root-verification' : 'current-signature-time-verification'
        : rootValidityMetadataProvided ? 'time-scoped-pinned-root-verification' : 'time-scoped-signature-verification',
    rootValidityMetadataProvided,
    ...(historical ? {} : { verifiedAt: effectiveVerificationTime })
  });
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const result = verifyManifestFile(parseArgs(argv));
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write('Offline trust-manifest verification failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_MANIFEST_BYTES,
  MAX_PUBLIC_KEY_BYTES,
  readBoundedRegularFile,
  readManifest,
  readRootPublicKey,
  parseArgs,
  verifyManifestFile,
  main
};
