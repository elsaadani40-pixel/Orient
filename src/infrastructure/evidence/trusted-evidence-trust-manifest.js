'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../../core/execution/evidence-record');

const MANIFEST_DOMAIN = Buffer.from('ORIENT-TRUSTED-EVIDENCE-MANIFEST-V1\0', 'utf8');
const KEY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isoTimestamp(value, code) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail(code, 'Timestamp must be a canonical UTC ISO-8601 value');
  }
  return value;
}

function normalizeManifestPayload({ version, issuedAt, keys }) {
  if (!Number.isSafeInteger(version) || version < 1) {
    fail('EVIDENCE_TRUST_MANIFEST_VERSION_INVALID', 'Trust manifest version must be a positive safe integer');
  }
  isoTimestamp(issuedAt, 'EVIDENCE_TRUST_MANIFEST_TIMESTAMP_INVALID');
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) ||
      Object.getPrototypeOf(keys) !== Object.prototype) {
    fail('EVIDENCE_TRUST_MANIFEST_KEYS_INVALID', 'Trust manifest keys must be a plain object');
  }
  const normalizedKeys = {};
  for (const keyId of Object.keys(keys).sort()) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      fail('EVIDENCE_TRUST_MANIFEST_KEY_ID_INVALID', 'Trust manifest contains an invalid key identifier');
    }
    const entry = keys[keyId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.publicKey !== 'string' || !entry.publicKey.trim()) {
      fail('EVIDENCE_TRUST_MANIFEST_KEY_INVALID', `Trust manifest key ${keyId} has no public key`);
    }
    const publicKey = crypto.createPublicKey(entry.publicKey);
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      fail('EVIDENCE_TRUST_MANIFEST_KEY_INVALID', `Trust manifest key ${keyId} must be Ed25519`);
    }
    const validFrom = entry.validFrom === undefined ? null :
      isoTimestamp(entry.validFrom, 'EVIDENCE_TRUST_MANIFEST_KEY_METADATA_INVALID');
    const revokedAt = entry.revokedAt === undefined ? null :
      isoTimestamp(entry.revokedAt, 'EVIDENCE_TRUST_MANIFEST_KEY_METADATA_INVALID');
    if (validFrom && revokedAt && revokedAt < validFrom) {
      fail('EVIDENCE_TRUST_MANIFEST_KEY_METADATA_INVALID', `Trust manifest key ${keyId} has an invalid validity interval`);
    }
    normalizedKeys[keyId] = {
      publicKey: entry.publicKey,
      ...(validFrom ? { validFrom } : {}),
      ...(revokedAt ? { revokedAt } : {})
    };
  }
  if (Object.keys(normalizedKeys).length === 0) {
    fail('EVIDENCE_TRUST_MANIFEST_KEYS_INVALID', 'Trust manifest must contain at least one verification key');
  }
  return { schemaVersion: 1, version, issuedAt, keys: normalizedKeys };
}

function signTrustManifest(input, { rootKeyId, rootPrivateKey } = {}) {
  if (typeof rootKeyId !== 'string' || !KEY_ID_PATTERN.test(rootKeyId)) {
    fail('EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID', 'A valid offline root key identifier is required');
  }
  if (!rootPrivateKey) fail('EVIDENCE_TRUST_MANIFEST_ROOT_KEY_REQUIRED', 'An offline root private key is required');
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(rootPrivateKey);
  } catch {
    fail('EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID', 'Unable to load trust manifest root private key');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID', 'Trust manifest root key must use Ed25519');
  }
  const payload = normalizeManifestPayload(input);
  const unsigned = { ...payload, rootKeyId };
  const signature = crypto.sign(
    null,
    Buffer.concat([MANIFEST_DOMAIN, Buffer.from(canonicalJson(unsigned), 'utf8')]),
    privateKey
  ).toString('base64');
  return Object.freeze({ ...unsigned, signature });
}

function verifyTrustManifest(manifest, trustedRootKeys) {
  try {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
        manifest.schemaVersion !== 1 || typeof manifest.rootKeyId !== 'string' ||
        !KEY_ID_PATTERN.test(manifest.rootKeyId) || typeof manifest.signature !== 'string') return null;
    const { signature, ...unsigned } = manifest;
    const payload = normalizeManifestPayload(unsigned);
    const rebuilt = { ...payload, rootKeyId: unsigned.rootKeyId };
    if (canonicalJson(rebuilt) !== canonicalJson(unsigned)) return null;
    const rootEntry = trustedRootKeys?.[unsigned.rootKeyId];
    if (!rootEntry || typeof rootEntry.publicKey !== 'string') return null;
    const rootPublicKey = crypto.createPublicKey(rootEntry.publicKey);
    if (rootPublicKey.asymmetricKeyType !== 'ed25519') return null;
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.toString('base64') !== signature) return null;
    const valid = crypto.verify(
      null,
      Buffer.concat([MANIFEST_DOMAIN, Buffer.from(canonicalJson(rebuilt), 'utf8')]),
      rootPublicKey,
      signatureBytes
    );
    if (!valid) return null;
    return Object.freeze({ ...payload, digest: sha256(canonicalJson(manifest)) });
  } catch {
    return null;
  }
}

/*
 * versionStore is an independent durable monotonic store:
 *   read() -> null | { version: number, digest: sha256 }
 *   compareAndSet(expectedState, nextState) -> boolean
 * Its CAS must be atomic and must not permit rollback by the Runtime identity.
 */
async function verifyAndAcceptTrustManifest(manifest, { trustedRootKeys, versionStore } = {}) {
  if (!versionStore || typeof versionStore.read !== 'function' ||
      typeof versionStore.compareAndSet !== 'function') {
    fail('EVIDENCE_TRUST_MANIFEST_STORE_REQUIRED', 'An independent durable monotonic version store is required');
  }
  const verified = verifyTrustManifest(manifest, trustedRootKeys);
  if (!verified) fail('EVIDENCE_TRUST_MANIFEST_SIGNATURE_INVALID', 'Trust manifest signature or payload is invalid');
  const current = await versionStore.read();
  if (current !== null && (!current || !Number.isSafeInteger(current.version) ||
      current.version < 1 || !HASH_PATTERN.test(current.digest || ''))) {
    fail('EVIDENCE_TRUST_MANIFEST_STORE_INVALID', 'Monotonic trust state is malformed');
  }
  if (current && verified.version < current.version) {
    fail('EVIDENCE_TRUST_MANIFEST_ROLLBACK', 'A previously accepted trust manifest version cannot be rolled back');
  }
  if (current && verified.version === current.version) {
    if (verified.digest !== current.digest) {
      fail('EVIDENCE_TRUST_MANIFEST_VERSION_CONFLICT', 'A trust manifest version cannot identify different content');
    }
    return verified;
  }
  const accepted = await versionStore.compareAndSet(
    current,
    { version: verified.version, digest: verified.digest }
  );
  if (!accepted) {
    fail('EVIDENCE_TRUST_MANIFEST_STATE_RACE', 'Trust manifest state changed concurrently; reload and verify again');
  }
  return verified;
}

module.exports = {
  MANIFEST_DOMAIN: MANIFEST_DOMAIN.toString('utf8'),
  signTrustManifest,
  verifyTrustManifest,
  verifyAndAcceptTrustManifest
};
