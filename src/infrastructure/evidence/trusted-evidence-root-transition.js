'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../../core/execution/evidence-record');

const TRANSITION_DOMAIN = Buffer.from('ORIENT-TRUST-ROOT-TRANSITION-V1\0', 'utf8');
const PROOF_DOMAIN = Buffer.from('ORIENT-TRUST-ROOT-PROOF-OF-POSSESSION-V1\0', 'utf8');
const DIGEST_DOMAIN = Buffer.from('ORIENT-TRUST-ROOT-TRANSITION-DIGEST-V1\0', 'utf8');
const KEY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PAYLOAD_FIELDS = [
  'schemaVersion', 'transitionSequence', 'previousTransitionDigest', 'mode',
  'previousRootEpoch', 'nextRootEpoch', 'previousRootKeyId', 'previousRootFingerprint',
  'nextRootKeyId', 'nextRootPublicKey', 'nextRootFingerprint',
  'manifestHeadVersion', 'manifestHeadDigest', 'issuedAt', 'effectiveAt',
  'expiresAt', 'recoveryPolicyDigest'
];

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataProperty(object, key, code) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail(code, 'Root transition accepts enumerable data properties only');
  }
  return descriptor.value;
}

function assertFields(object, allowed, code) {
  if (!isPlainRecord(object)) fail(code, 'Root transition value must be a plain record');
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      fail(code, 'Root transition contains unsupported properties');
    }
    readDataProperty(object, key, code);
  }
}

function timestamp(value, code) {
  if (typeof value !== 'string') fail(code, 'A canonical UTC timestamp is required');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail(code, 'Timestamp must be canonical UTC ISO-8601');
  }
  return value;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function publicKeyObject(value, code) {
  let key;
  try {
    key = crypto.createPublicKey(value);
  } catch {
    fail(code, 'Unable to parse Ed25519 public key');
  }
  if (key.asymmetricKeyType !== 'ed25519') fail(code, 'Root transition keys must use Ed25519');
  return key;
}

function privateKeyObject(value, code) {
  let key;
  try {
    key = crypto.createPrivateKey(value);
  } catch {
    fail(code, 'Unable to parse Ed25519 private key');
  }
  if (key.asymmetricKeyType !== 'ed25519') fail(code, 'Root transition keys must use Ed25519');
  return key;
}

function publicKeyFingerprint(publicKey) {
  const key = publicKeyObject(publicKey, 'EVIDENCE_ROOT_TRANSITION_KEY_INVALID');
  return sha256(key.export({ type: 'spki', format: 'der' }));
}

function normalizePayload(input) {
  assertFields(input, PAYLOAD_FIELDS, 'EVIDENCE_ROOT_TRANSITION_INVALID');
  const payload = Object.fromEntries(PAYLOAD_FIELDS.map(key => [key,
    readDataProperty(input, key, 'EVIDENCE_ROOT_TRANSITION_INVALID')]));
  if (payload.schemaVersion !== 1 ||
      !Number.isSafeInteger(payload.transitionSequence) || payload.transitionSequence < 1 ||
      (payload.previousTransitionDigest !== null && !HASH_PATTERN.test(payload.previousTransitionDigest || '')) ||
      !['planned-rotation', 'emergency-recovery'].includes(payload.mode) ||
      !Number.isSafeInteger(payload.previousRootEpoch) || payload.previousRootEpoch < 1 ||
      payload.nextRootEpoch !== payload.previousRootEpoch + 1 ||
      typeof payload.previousRootKeyId !== 'string' || !KEY_ID_PATTERN.test(payload.previousRootKeyId) ||
      typeof payload.nextRootKeyId !== 'string' || !KEY_ID_PATTERN.test(payload.nextRootKeyId) ||
      payload.previousRootKeyId === payload.nextRootKeyId ||
      !HASH_PATTERN.test(payload.previousRootFingerprint || '') ||
      !HASH_PATTERN.test(payload.nextRootFingerprint || '') ||
      typeof payload.nextRootPublicKey !== 'string' || !payload.nextRootPublicKey.trim() ||
      !Number.isSafeInteger(payload.manifestHeadVersion) || payload.manifestHeadVersion < 1 ||
      !HASH_PATTERN.test(payload.manifestHeadDigest || '') ||
      !HASH_PATTERN.test(payload.recoveryPolicyDigest || '')) {
    fail('EVIDENCE_ROOT_TRANSITION_INVALID', 'Root transition payload fields are invalid');
  }
  const nextFingerprint = publicKeyFingerprint(payload.nextRootPublicKey);
  if (nextFingerprint !== payload.nextRootFingerprint) {
    fail('EVIDENCE_ROOT_TRANSITION_FINGERPRINT_MISMATCH', 'Next-root fingerprint does not match its public key');
  }
  payload.issuedAt = timestamp(payload.issuedAt, 'EVIDENCE_ROOT_TRANSITION_TIME_INVALID');
  payload.effectiveAt = timestamp(payload.effectiveAt, 'EVIDENCE_ROOT_TRANSITION_TIME_INVALID');
  payload.expiresAt = timestamp(payload.expiresAt, 'EVIDENCE_ROOT_TRANSITION_TIME_INVALID');
  if (payload.effectiveAt < payload.issuedAt || payload.expiresAt <= payload.issuedAt) {
    fail('EVIDENCE_ROOT_TRANSITION_TIME_INVALID', 'Transition effective/expiry timestamps are inconsistent');
  }
  return payload;
}

function normalizeRecoveryPolicy(policy) {
  if (!isPlainRecord(policy) || !Number.isSafeInteger(policy.threshold) ||
      !Array.isArray(policy.authorities) || policy.threshold < 1 ||
      policy.threshold > policy.authorities.length) {
    fail('EVIDENCE_ROOT_RECOVERY_POLICY_INVALID', 'A valid pinned recovery authority set and threshold are required');
  }
  const seen = new Set();
  const authorities = policy.authorities.map(authority => {
    assertFields(authority, ['keyId', 'publicKey', 'validFrom', 'revokedAt'],
      'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
    const keyId = readDataProperty(authority, 'keyId', 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
    const publicKey = readDataProperty(authority, 'publicKey', 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
    const validFromValue = readDataProperty(authority, 'validFrom', 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
    const revokedAtValue = readDataProperty(authority, 'revokedAt', 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
    if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId) || seen.has(keyId) ||
        typeof publicKey !== 'string' || !publicKey.trim()) {
      fail('EVIDENCE_ROOT_RECOVERY_POLICY_INVALID', 'Recovery authority IDs and public keys must be unique and valid');
    }
    seen.add(keyId);
    const fingerprint = publicKeyFingerprint(publicKey);
    const validFrom = validFromValue === undefined ? null
      : timestamp(validFromValue, 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
    const revokedAt = revokedAtValue === undefined ? null
      : timestamp(revokedAtValue, 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID');
    if (validFrom && revokedAt && revokedAt < validFrom) {
      fail('EVIDENCE_ROOT_RECOVERY_POLICY_INVALID', 'Recovery authority validity interval is invalid');
    }
    return { keyId, fingerprint, publicKey, ...(validFrom ? { validFrom } : {}),
      ...(revokedAt ? { revokedAt } : {}) };
  }).sort((a, b) => a.keyId.localeCompare(b.keyId));
  return { threshold: policy.threshold, authorities };
}

function recoveryPolicyDigest(policy) {
  const normalized = normalizeRecoveryPolicy(policy);
  return sha256(Buffer.from(canonicalJson({
    threshold: normalized.threshold,
    authorities: normalized.authorities.map(({ keyId, fingerprint, validFrom, revokedAt }) => ({
      keyId, fingerprint, validFrom: validFrom || null, revokedAt: revokedAt || null
    }))
  }), 'utf8'));
}

function signatureBytes(value, code) {
  if (typeof value !== 'string' || !value) fail(code, 'A base64 signature is required');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length !== 64) {
    fail(code, 'Signature must be canonical base64 Ed25519 bytes');
  }
  return bytes;
}

function signBytes(domain, value, privateKey) {
  return crypto.sign(null, Buffer.concat([domain, Buffer.from(canonicalJson(value), 'utf8')]), privateKey).toString('base64');
}

function verifyBytes(domain, value, signature, publicKey) {
  try {
    return crypto.verify(null, Buffer.concat([domain, Buffer.from(canonicalJson(value), 'utf8')]),
      publicKey, signatureBytes(signature, 'EVIDENCE_ROOT_TRANSITION_SIGNATURE_INVALID'));
  } catch {
    return false;
  }
}

function envelopeDigest(payload, authorizationSignatures, nextRootProof) {
  const body = { payload, authorizationSignatures, nextRootProof };
  return sha256(Buffer.concat([DIGEST_DOMAIN, Buffer.from(canonicalJson(body), 'utf8')]));
}

/**
 * Sign a planned rotation with the current root, or an emergency recovery
 * with a configured recovery quorum. The next root always proves possession.
 */
function signRootTransition(input, {
  currentRootKeyId,
  currentRootPrivateKey,
  nextRootPrivateKey,
  recoverySigners = []
} = {}) {
  const payload = normalizePayload(input);
  const payloadBytes = payload;
  const authorizationSignatures = [];

  if (payload.mode === 'planned-rotation') {
    if (currentRootKeyId !== payload.previousRootKeyId || !currentRootPrivateKey) {
      fail('EVIDENCE_ROOT_TRANSITION_AUTHORITY_REQUIRED', 'Planned rotation requires the current root private key');
    }
    const key = privateKeyObject(currentRootPrivateKey, 'EVIDENCE_ROOT_TRANSITION_KEY_INVALID');
    authorizationSignatures.push({
      keyId: currentRootKeyId,
      signature: signBytes(TRANSITION_DOMAIN, payloadBytes, key)
    });
  } else {
    if (!Array.isArray(recoverySigners) || recoverySigners.length === 0) {
      fail('EVIDENCE_ROOT_RECOVERY_QUORUM_REQUIRED', 'Emergency recovery requires recovery authority signatures');
    }
    for (const signer of recoverySigners) {
      if (!signer || typeof signer.keyId !== 'string' || !KEY_ID_PATTERN.test(signer.keyId)) {
        fail('EVIDENCE_ROOT_RECOVERY_SIGNER_INVALID', 'Recovery signer key ID is invalid');
      }
      const key = privateKeyObject(signer.privateKey, 'EVIDENCE_ROOT_RECOVERY_SIGNER_INVALID');
      authorizationSignatures.push({
        keyId: signer.keyId,
        signature: signBytes(TRANSITION_DOMAIN, payloadBytes, key)
      });
    }
    authorizationSignatures.sort((a, b) => a.keyId.localeCompare(b.keyId));
  }

  const nextRootProof = signBytes(PROOF_DOMAIN, payloadBytes,
    privateKeyObject(nextRootPrivateKey, 'EVIDENCE_ROOT_TRANSITION_PROOF_REQUIRED'));
  const digest = envelopeDigest(payload, authorizationSignatures, nextRootProof);
  return Object.freeze({
    payload: Object.freeze(payload),
    authorizationSignatures: Object.freeze(authorizationSignatures.map(Object.freeze)),
    nextRootProof,
    transitionDigest: digest
  });
}

function validAt(entry, issuedAt, verificationTime) {
  const validFrom = entry.validFrom ? timestamp(entry.validFrom, 'EVIDENCE_ROOT_TRANSITION_KEY_METADATA_INVALID') : null;
  const revokedAt = entry.revokedAt ? timestamp(entry.revokedAt, 'EVIDENCE_ROOT_TRANSITION_KEY_METADATA_INVALID') : null;
  return (!validFrom || (issuedAt >= validFrom && verificationTime >= validFrom)) &&
    (!revokedAt || (issuedAt < revokedAt && verificationTime < revokedAt));
}

/**
 * Verify a transition against independently pinned current state and recovery
 * policy. Clock skew and maximum validity are mandatory bounded host settings.
 */
function verifyRootTransition(envelope, {
  trustedRootKeys,
  recoveryPolicy,
  expectedState,
  verificationTime,
  clockSkewMs,
  maxValidityMs
} = {}) {
  try {
    assertFields(envelope, ['payload', 'authorizationSignatures', 'nextRootProof', 'transitionDigest'],
      'EVIDENCE_ROOT_TRANSITION_INVALID');
    const payload = normalizePayload(readDataProperty(envelope, 'payload', 'EVIDENCE_ROOT_TRANSITION_INVALID'));
    const authorizationSignatures = readDataProperty(envelope, 'authorizationSignatures', 'EVIDENCE_ROOT_TRANSITION_INVALID');
    const nextRootProof = readDataProperty(envelope, 'nextRootProof', 'EVIDENCE_ROOT_TRANSITION_INVALID');
    const transitionDigest = readDataProperty(envelope, 'transitionDigest', 'EVIDENCE_ROOT_TRANSITION_INVALID');
    if (!Array.isArray(authorizationSignatures) || typeof nextRootProof !== 'string' ||
        !HASH_PATTERN.test(transitionDigest || '') ||
        transitionDigest !== envelopeDigest(payload, authorizationSignatures, nextRootProof)) return null;

    const now = timestamp(verificationTime, 'EVIDENCE_ROOT_TRANSITION_TIME_INVALID');
    if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs > 10 * 60 * 1000 ||
        !Number.isSafeInteger(maxValidityMs) || maxValidityMs < 60 * 1000 ||
        maxValidityMs > 30 * 24 * 60 * 60 * 1000) return null;
    if (Date.parse(payload.issuedAt) > Date.parse(now) + clockSkewMs ||
        Date.parse(payload.expiresAt) <= Date.parse(now) ||
        Date.parse(payload.effectiveAt) > Date.parse(now) ||
        Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt) > maxValidityMs) return null;

    if (!isPlainRecord(expectedState) || !Number.isSafeInteger(expectedState.rootEpoch) ||
        !Number.isSafeInteger(expectedState.transitionSequence) || expectedState.transitionSequence < 0 ||
        (expectedState.transitionSequence === 0 ? expectedState.transitionDigest !== null : !HASH_PATTERN.test(expectedState.transitionDigest || '')) ||
        !Array.isArray(expectedState.usedRootKeyIds) ||
        !expectedState.usedRootKeyIds.includes(payload.previousRootKeyId) ||
        expectedState.rootEpoch !== payload.previousRootEpoch ||
        expectedState.rootKeyId !== payload.previousRootKeyId ||
        expectedState.rootFingerprint !== payload.previousRootFingerprint ||
        expectedState.manifestHeadVersion !== payload.manifestHeadVersion ||
        expectedState.manifestHeadDigest !== payload.manifestHeadDigest ||
        payload.transitionSequence !== expectedState.transitionSequence + 1 ||
        payload.previousTransitionDigest !== expectedState.transitionDigest) return null;

    if (!isPlainRecord(trustedRootKeys)) return null;
    const rootEntry = readDataProperty(trustedRootKeys, payload.previousRootKeyId,
      'EVIDENCE_ROOT_TRANSITION_KEY_INVALID');
    if (!isPlainRecord(rootEntry)) return null;
    assertFields(rootEntry, ['publicKey', 'validFrom', 'revokedAt'], 'EVIDENCE_ROOT_TRANSITION_KEY_INVALID');
    const currentRootKeyText = readDataProperty(rootEntry, 'publicKey', 'EVIDENCE_ROOT_TRANSITION_KEY_INVALID');
    const currentRootEntry = {
      publicKey: currentRootKeyText,
      validFrom: readDataProperty(rootEntry, 'validFrom', 'EVIDENCE_ROOT_TRANSITION_KEY_INVALID'),
      revokedAt: readDataProperty(rootEntry, 'revokedAt', 'EVIDENCE_ROOT_TRANSITION_KEY_INVALID')
    };
    if (typeof currentRootKeyText !== 'string' ||
        publicKeyFingerprint(currentRootKeyText) !== payload.previousRootFingerprint ||
        (payload.mode === 'planned-rotation' && !validAt(currentRootEntry, payload.issuedAt, now))) return null;
    const currentRootPublicKey = publicKeyObject(currentRootKeyText, 'EVIDENCE_ROOT_TRANSITION_KEY_INVALID');

    if (expectedState.usedRootKeyIds.includes(payload.nextRootKeyId) ||
        (Array.isArray(expectedState.usedRootFingerprints) &&
          expectedState.usedRootFingerprints.includes(payload.nextRootFingerprint))) return null;
    if (publicKeyFingerprint(payload.nextRootPublicKey) === payload.previousRootFingerprint) return null;
    const nextRootPublicKey = publicKeyObject(payload.nextRootPublicKey, 'EVIDENCE_ROOT_TRANSITION_KEY_INVALID');

    if (!verifyBytes(PROOF_DOMAIN, payload, nextRootProof, nextRootPublicKey)) return null;

    if (payload.mode === 'planned-rotation') {
      if (authorizationSignatures.length !== 1) return null;
      const signature = authorizationSignatures[0];
      assertFields(signature, ['keyId', 'signature'], 'EVIDENCE_ROOT_TRANSITION_SIGNATURE_INVALID');
      if (readDataProperty(signature, 'keyId', 'EVIDENCE_ROOT_TRANSITION_SIGNATURE_INVALID') !== payload.previousRootKeyId ||
          !verifyBytes(TRANSITION_DOMAIN, payload,
            readDataProperty(signature, 'signature', 'EVIDENCE_ROOT_TRANSITION_SIGNATURE_INVALID'),
            currentRootPublicKey)) return null;
      if (payload.recoveryPolicyDigest !== recoveryPolicyDigest(recoveryPolicy)) return null;
    } else {
      const policy = normalizeRecoveryPolicy(recoveryPolicy);
      if (payload.recoveryPolicyDigest !== recoveryPolicyDigest(policy) ||
          authorizationSignatures.length < policy.threshold) return null;
      const authorities = new Map(policy.authorities.map(authority => [authority.keyId, authority]));
      const seen = new Set();
      let previousSignerId = null;
      for (const signature of authorizationSignatures) {
        assertFields(signature, ['keyId', 'signature'], 'EVIDENCE_ROOT_TRANSITION_SIGNATURE_INVALID');
        const keyId = readDataProperty(signature, 'keyId', 'EVIDENCE_ROOT_TRANSITION_SIGNATURE_INVALID');
        if (typeof keyId !== 'string' || seen.has(keyId) ||
            (previousSignerId !== null && keyId.localeCompare(previousSignerId) <= 0)) return null;
        seen.add(keyId);
        previousSignerId = keyId;
        const authority = authorities.get(keyId);
        if (!authority || !validAt(authority, payload.issuedAt, now) ||
            !verifyBytes(TRANSITION_DOMAIN, payload,
              readDataProperty(signature, 'signature', 'EVIDENCE_ROOT_TRANSITION_SIGNATURE_INVALID'),
              publicKeyObject(authority.publicKey, 'EVIDENCE_ROOT_RECOVERY_POLICY_INVALID'))) return null;
      }
      if (seen.size < policy.threshold) return null;
    }

    return Object.freeze({
      payload: Object.freeze(payload),
      transitionDigest,
      nextRoot: Object.freeze({
        keyId: payload.nextRootKeyId,
        publicKey: payload.nextRootPublicKey,
        fingerprint: payload.nextRootFingerprint
      }),
      verifiedAt: now
    });
  } catch {
    return null;
  }
}

module.exports = {
  TRANSITION_DOMAIN: TRANSITION_DOMAIN.toString('utf8'),
  PROOF_DOMAIN: PROOF_DOMAIN.toString('utf8'),
  DIGEST_DOMAIN: DIGEST_DOMAIN.toString('utf8'),
  publicKeyFingerprint,
  recoveryPolicyDigest,
  signRootTransition,
  verifyRootTransition
};
