'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  signTrustManifest,
  verifyTrustManifest
} = require('../src/infrastructure/evidence/trusted-evidence-trust-manifest');

const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const USAGE = 'Usage: node scripts/sign-trust-manifest-offline.js --input <manifest.json> --key <offline-root-private.pem> --root-key-id <id> --output <signed-manifest.json>';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isWithinDirectory(directory, target) {
  const relative = path.relative(directory, target);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function readPrivateKeyFile(filePath, {
  repoRoot = path.resolve(__dirname, '..'),
  platform = process.platform
} = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    fail('TRUST_SIGNER_KEY_PATH_REQUIRED', 'An offline root private-key file path is required');
  }

  const absolutePath = path.resolve(filePath);
  const absoluteRepoRoot = path.resolve(repoRoot);
  if (isWithinDirectory(absoluteRepoRoot, absolutePath)) {
    fail('TRUST_SIGNER_KEY_MUST_BE_OUTSIDE_REPOSITORY', 'The offline root private key must be stored outside the repository');
  }

  let descriptor;
  let keyBytes;
  let bounded;
  try {
    const before = fs.lstatSync(absolutePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      fail('TRUST_SIGNER_KEY_FILE_INVALID', 'The offline root private key must be a regular non-symlink file');
    }
    if (before.size < 1 || before.size > MAX_PRIVATE_KEY_BYTES || before.nlink !== 1n) {
      fail('TRUST_SIGNER_KEY_FILE_INVALID', 'The offline root private-key file has an invalid size or link count');
    }
    if (platform !== 'win32' && typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) {
      fail('TRUST_SIGNER_KEY_OWNER_INVALID', 'The offline root private-key file must be owned by the signing user');
    }
    if (platform !== 'win32' && (before.mode & 0o077n) !== 0) {
      fail('TRUST_SIGNER_KEY_PERMISSIONS_INVALID', 'The offline root private-key file must not be accessible by group or other users (chmod 600)');
    }

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      fail('TRUST_SIGNER_KEY_FILE_CHANGED', 'The offline root private-key file changed while it was being opened');
    }
    if (after.size < 1 || after.size > MAX_PRIVATE_KEY_BYTES || after.nlink !== 1n ||
        (platform !== 'win32' && typeof process.getuid === 'function' && after.uid !== BigInt(process.getuid())) ||
        (platform !== 'win32' && (after.mode & 0o077n) !== 0)) {
      fail('TRUST_SIGNER_KEY_PERMISSIONS_INVALID', 'The offline root private-key file permissions or size changed while opening');
    }
    // Never use readFileSync(fd) for secret material: a file can grow after
    // the metadata check and cause an unbounded allocation. Read at most
    // MAX_PRIVATE_KEY_BYTES + 1 bytes, then re-check the opened inode.
    bounded = Buffer.alloc(MAX_PRIVATE_KEY_BYTES + 1);
    let total = 0;
    while (total < bounded.length) {
      const read = fs.readSync(
        descriptor,
        bounded,
        total,
        Math.min(16 * 1024, bounded.length - total),
        null
      );
      if (read === 0) break;
      total += read;
    }
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    if (total < 1 || total > MAX_PRIVATE_KEY_BYTES || afterRead.size !== BigInt(total) ||
        afterRead.dev !== before.dev || afterRead.ino !== before.ino ||
        afterRead.nlink !== 1n ||
        (platform !== 'win32' && typeof process.getuid === 'function' && afterRead.uid !== BigInt(process.getuid())) ||
        (platform !== 'win32' && (afterRead.mode & 0o077n) !== 0)) {
      bounded.fill(0);
      fail('TRUST_SIGNER_KEY_FILE_INVALID', 'The offline root private-key file changed or exceeded its size limit while reading');
    }
    keyBytes = Buffer.from(bounded.subarray(0, total));
    bounded.fill(0);
    return keyBytes;
  } catch (error) {
    if (error && error.code && error.code.startsWith('TRUST_SIGNER_')) throw error;
    fail('TRUST_SIGNER_KEY_FILE_UNREADABLE', 'Unable to safely read the offline root private-key file');
  } finally {
    if (bounded) bounded.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readManifestFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    fail('TRUST_SIGNER_INPUT_REQUIRED', 'A manifest input file path is required');
  }
  const absolutePath = path.resolve(filePath);
  let descriptor;
  let bytes;
  try {
    const before = fs.lstatSync(absolutePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() ||
        before.size < 1n || before.size > BigInt(MAX_MANIFEST_BYTES)) {
      fail('TRUST_SIGNER_INPUT_INVALID', 'The trust manifest input must be a regular non-symlink file no larger than 1 MiB');
    }
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size < 1n || opened.size > BigInt(MAX_MANIFEST_BYTES)) {
      fail('TRUST_SIGNER_INPUT_INVALID', 'The trust manifest input changed while it was being opened');
    }
    const bounded = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let total = 0;
    while (total < bounded.length) {
      const read = fs.readSync(descriptor, bounded, total,
        Math.min(64 * 1024, bounded.length - total), null);
      if (read === 0) break;
      total += read;
    }
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    if (total < 1 || total > MAX_MANIFEST_BYTES || afterRead.size !== BigInt(total) ||
        afterRead.dev !== before.dev || afterRead.ino !== before.ino ||
        afterRead.mtimeNs !== opened.mtimeNs || afterRead.ctimeNs !== opened.ctimeNs) {
      bounded.fill(0);
      fail('TRUST_SIGNER_INPUT_INVALID', 'The trust manifest input changed or exceeded its size limit while reading');
    }
    bytes = Buffer.from(bounded.subarray(0, total));
    bounded.fill(0);
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('TRUST_SIGNER_INPUT_INVALID', 'The trust manifest input must contain valid JSON');
    }
  } catch (error) {
    if (error && error.code && error.code.startsWith('TRUST_SIGNER_')) throw error;
    fail('TRUST_SIGNER_INPUT_UNREADABLE', 'Unable to safely read the trust manifest input file');
  } finally {
    if (bytes) bytes.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeCreateOnly(filePath, content) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    fail('TRUST_SIGNER_OUTPUT_REQUIRED', 'A signed manifest output file path is required');
  }
  const absolutePath = path.resolve(filePath);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(absolutePath, 'wx', 0o644);
    created = true;
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      descriptor = undefined;
    }
    if (created) {
      try { fs.unlinkSync(absolutePath); } catch {}
    }
    if (error && error.code === 'EEXIST') {
      fail('TRUST_SIGNER_OUTPUT_EXISTS', 'Refusing to overwrite an existing signed manifest');
    }
    fail('TRUST_SIGNER_OUTPUT_WRITE_FAILED', 'Unable to create the signed manifest output file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return absolutePath;
}

function signManifestFile({
  inputPath,
  keyPath,
  rootKeyId,
  outputPath,
  repoRoot = path.resolve(__dirname, '..'),
  platform = process.platform,
  now = () => new Date().toISOString()
} = {}) {
  if (typeof rootKeyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rootKeyId)) {
    fail('TRUST_SIGNER_ROOT_KEY_ID_INVALID', 'A valid root key identifier is required');
  }

  const manifest = readManifestFile(inputPath);
  const privateKeyBytes = readPrivateKeyFile(keyPath, { repoRoot, platform });
  try {
    let privateKey;
    try {
      privateKey = crypto.createPrivateKey(privateKeyBytes);
    } catch {
      fail('TRUST_SIGNER_KEY_INVALID', 'The offline root private-key file is not a valid supported private key');
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      fail('TRUST_SIGNER_KEY_TYPE_INVALID', 'The offline root private key must be Ed25519');
    }
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const signed = signTrustManifest(manifest, {
      rootKeyId,
      rootPrivateKey: privateKeyBytes
    });
    const verificationTime = now();
    const verified = verifyTrustManifest(
      signed,
      { [rootKeyId]: { publicKey: publicKeyPem } },
      { verificationTime }
    );
    if (!verified) {
      fail('TRUST_SIGNER_SELF_VERIFICATION_FAILED', 'The signed manifest did not pass local signature and validity verification');
    }

    const serialized = JSON.stringify(signed, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) {
      fail('TRUST_SIGNER_OUTPUT_TOO_LARGE', 'The signed manifest exceeds the 1 MiB output limit');
    }
    const writtenPath = writeCreateOnly(outputPath, serialized);
    return Object.freeze({
      outputPath: writtenPath,
      version: verified.version,
      digest: verified.digest
    });
  } finally {
    privateKeyBytes.fill(0);
  }
}

function parseArgs(argv) {
  const mapping = {
    '--input': 'inputPath',
    '--key': 'keyPath',
    '--root-key-id': 'rootKeyId',
    '--output': 'outputPath'
  };
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const property = mapping[flag];
    if (!property || Object.prototype.hasOwnProperty.call(options, property)) {
      fail('TRUST_SIGNER_ARGUMENT_INVALID', USAGE);
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      fail('TRUST_SIGNER_ARGUMENT_INVALID', USAGE);
    }
    options[property] = value;
    index += 1;
  }
  if (Object.keys(options).length !== 4) {
    fail('TRUST_SIGNER_ARGUMENT_INVALID', USAGE);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const result = signManifestFile(parseArgs(argv));
  process.stdout.write('Signed trust manifest v' + result.version +
    ' (sha256 ' + result.digest + ') to ' + result.outputPath + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write('Offline trust-manifest signing failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_PRIVATE_KEY_BYTES,
  MAX_MANIFEST_BYTES,
  readPrivateKeyFile,
  signManifestFile,
  parseArgs,
  main
};
