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

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataProperty(object, key, code) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail(code, 'Trust manifest accepts enumerable data properties only');
  }
  return descriptor.value;
}

function assertAllowedDataProperties(object, allowed, code) {
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      fail(code, 'Trust manifest contains unsupported properties');
    }
    ownDataProperty(object, key, code);
  }
}

function normalizeManifestPayload(input) {
  if (!isPlainRecord(input)) fail('EVIDENCE_TRUST_MANIFEST_INVALID', 'Trust manifest payload must be a plain record');
  assertAllowedDataProperties(input, ['schemaVersion', 'version', 'issuedAt', 'keys'], 'EVIDENCE_TRUST_MANIFEST_INVALID');
  const schemaVersion = ownDataProperty(input, 'schemaVersion', 'EVIDENCE_TRUST_MANIFEST_INVALID');
  const version = ownDataProperty(input, 'version', 'EVIDENCE_TRUST_MANIFEST_INVALID');
  const issuedAt = ownDataProperty(input, 'issuedAt', 'EVIDENCE_TRUST_MANIFEST_INVALID');
  const keys = ownDataProperty(input, 'keys', 'EVIDENCE_TRUST_MANIFEST_KEYS_INVALID');
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    fail('EVIDENCE_TRUST_MANIFEST_VERSION_INVALID', 'Unsupported trust manifest schema version');
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    fail('EVIDENCE_TRUST_MANIFEST_VERSION_INVALID', 'Trust manifest version must be a positive safe integer');
  }
  isoTimestamp(issuedAt, 'EVIDENCE_TRUST_MANIFEST_TIMESTAMP_INVALID');
  if (!isPlainRecord(keys)) fail('EVIDENCE_TRUST_MANIFEST_KEYS_INVALID', 'Trust manifest keys must be a plain record');
  const normalizedKeys = {};
  for (const keyId of Reflect.ownKeys(keys).sort()) {
    if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
      fail('EVIDENCE_TRUST_MANIFEST_KEY_ID_INVALID', 'Trust manifest contains an invalid key identifier');
    }
    const entry = ownDataProperty(keys, keyId, 'EVIDENCE_TRUST_MANIFEST_KEY_INVALID');
    if (!isPlainRecord(entry)) fail('EVIDENCE_TRUST_MANIFEST_KEY_INVALID', `Trust manifest key ${keyId} must be a plain record`);
    assertAllowedDataProperties(entry, ['publicKey', 'validFrom', 'revokedAt'], 'EVIDENCE_TRUST_MANIFEST_KEY_INVALID');
    const publicKeyText = ownDataProperty(entry, 'publicKey', 'EVIDENCE_TRUST_MANIFEST_KEY_INVALID');
    if (typeof publicKeyText !== 'string' || !publicKeyText.trim()) {
      fail('EVIDENCE_TRUST_MANIFEST_KEY_INVALID', `Trust manifest key ${keyId} has no public key`);
    }
    const publicKey = crypto.createPublicKey(publicKeyText);
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      fail('EVIDENCE_TRUST_MANIFEST_KEY_INVALID', `Trust manifest key ${keyId} must be Ed25519`);
    }
    const validFromValue = ownDataProperty(entry, 'validFrom', 'EVIDENCE_TRUST_MANIFEST_KEY_METADATA_INVALID');
    const revokedAtValue = ownDataProperty(entry, 'revokedAt', 'EVIDENCE_TRUST_MANIFEST_KEY_METADATA_INVALID');
    const validFrom = validFromValue === undefined ? null : isoTimestamp(validFromValue, 'EVIDENCE_TRUST_MANIFEST_KEY_METADATA_INVALID');
    const revokedAt = revokedAtValue === undefined ? null : isoTimestamp(revokedAtValue, 'EVIDENCE_TRUST_MANIFEST_KEY_METADATA_INVALID');
    if (validFrom && revokedAt && revokedAt < validFrom) {
      fail('EVIDENCE_TRUST_MANIFEST_KEY_METADATA_INVALID', `Trust manifest key ${keyId} has an invalid validity interval`);
    }
    normalizedKeys[keyId] = { publicKey: publicKeyText, ...(validFrom ? { validFrom } : {}), ...(revokedAt ? { revokedAt } : {}) };
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

function verifyTrustManifest(manifest, trustedRootKeys, { verificationTime } = {}) {
  try {
    if (!isPlainRecord(manifest)) return null;
    assertAllowedDataProperties(manifest, ['schemaVersion', 'version', 'issuedAt', 'keys', 'rootKeyId', 'signature'],
      'EVIDENCE_TRUST_MANIFEST_INVALID');
    const schemaVersion = ownDataProperty(manifest, 'schemaVersion', 'EVIDENCE_TRUST_MANIFEST_INVALID');
    const rootKeyId = ownDataProperty(manifest, 'rootKeyId', 'EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID');
    const signature = ownDataProperty(manifest, 'signature', 'EVIDENCE_TRUST_MANIFEST_SIGNATURE_INVALID');
    if (schemaVersion !== 1 || typeof rootKeyId !== 'string' || !KEY_ID_PATTERN.test(rootKeyId) ||
        typeof signature !== 'string') return null;
    const unsigned = {
      schemaVersion,
      version: ownDataProperty(manifest, 'version', 'EVIDENCE_TRUST_MANIFEST_INVALID'),
      issuedAt: ownDataProperty(manifest, 'issuedAt', 'EVIDENCE_TRUST_MANIFEST_INVALID'),
      keys: ownDataProperty(manifest, 'keys', 'EVIDENCE_TRUST_MANIFEST_INVALID')
    };
    const payload = normalizeManifestPayload(unsigned);
    const rebuilt = { ...payload, rootKeyId };
    if (canonicalJson(rebuilt) !== canonicalJson({ ...unsigned, rootKeyId })) return null;
    if (!isPlainRecord(trustedRootKeys)) return null;
    const rootEntry = ownDataProperty(trustedRootKeys, rootKeyId, 'EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID');
    if (!isPlainRecord(rootEntry)) return null;
    assertAllowedDataProperties(rootEntry, ['publicKey', 'validFrom', 'revokedAt'], 'EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID');
    const rootPublicKeyText = ownDataProperty(rootEntry, 'publicKey', 'EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID');
    if (typeof rootPublicKeyText !== 'string' || !rootPublicKeyText.trim()) return null;
    const rootValidFromValue = ownDataProperty(rootEntry, 'validFrom', 'EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID');
    const rootRevokedAtValue = ownDataProperty(rootEntry, 'revokedAt', 'EVIDENCE_TRUST_MANIFEST_ROOT_KEY_INVALID');
    const rootValidFrom = rootValidFromValue === undefined ? null
      : isoTimestamp(rootValidFromValue, 'EVIDENCE_TRUST_MANIFEST_ROOT_KEY_METADATA_INVALID');
    const rootRevokedAt = rootRevokedAtValue === undefined ? null
      : isoTimestamp(rootRevokedAtValue, 'EVIDENCE_TRUST_MANIFEST_ROOT_KEY_METADATA_INVALID');
    if (rootValidFrom && rootRevokedAt && rootRevokedAt < rootValidFrom) return null;
    if (rootValidFrom && payload.issuedAt < rootValidFrom) return null;
    if (rootRevokedAt && payload.issuedAt >= rootRevokedAt) return null;
    // Default verification is historical: assess the root at manifest issuance.
    // Acceptance callers must supply the current time so a revoked root cannot
    // authorize a delayed, pre-revocation manifest after the revocation event.
    const verificationTimestamp = verificationTime === undefined
      ? payload.issuedAt
      : isoTimestamp(verificationTime, 'EVIDENCE_TRUST_MANIFEST_VERIFICATION_TIME_INVALID');
    if (rootValidFrom && verificationTimestamp < rootValidFrom) return null;
    if (rootRevokedAt && verificationTimestamp >= rootRevokedAt) return null;
    const rootPublicKey = crypto.createPublicKey(rootPublicKeyText);
    if (rootPublicKey.asymmetricKeyType !== 'ed25519') return null;
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.toString('base64') !== signature) return null;
    const valid = crypto.verify(null, Buffer.concat([MANIFEST_DOMAIN, Buffer.from(canonicalJson(rebuilt), 'utf8')]),
      rootPublicKey, signatureBytes);
    if (!valid) return null;
    return Object.freeze({ ...payload, digest: sha256(canonicalJson({ ...rebuilt, signature })) });
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
async function verifyAndAcceptTrustManifest(manifest, { trustedRootKeys, versionStore, now = new Date().toISOString() } = {}) {
  if (!versionStore || typeof versionStore.read !== 'function' ||
      typeof versionStore.compareAndSet !== 'function') {
    fail('EVIDENCE_TRUST_MANIFEST_STORE_REQUIRED', 'An independent durable monotonic version store is required');
  }
  const verified = verifyTrustManifest(manifest, trustedRootKeys, { verificationTime: now });
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
