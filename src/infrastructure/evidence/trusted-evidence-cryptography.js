'use strict';

const crypto = require('node:crypto');
const { canonicalJson, verifyEvidenceRecord } = require('../../core/execution/evidence-record');

const RECORD_DOMAIN = Buffer.from('ORIENT-TRUSTED-EVIDENCE-V1\0', 'utf8');
const ANCHOR_DOMAIN = Buffer.from('ORIENT-TRUSTED-EVIDENCE-ANCHOR-V1\0', 'utf8');
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeKeyEntry(entry, keyId) {
  if (!entry || typeof entry !== 'object' || !entry.publicKey) {
    fail('EVIDENCE_KEY_UNKNOWN', `No trusted public key configured for ${keyId}`);
  }
  const validFrom = entry.validFrom ? new Date(entry.validFrom) : null;
  const revokedAt = entry.revokedAt ? new Date(entry.revokedAt) : null;
  if ((validFrom && !Number.isFinite(validFrom.getTime())) ||
      (revokedAt && !Number.isFinite(revokedAt.getTime())) ||
      (validFrom && revokedAt && revokedAt < validFrom)) {
    fail('EVIDENCE_KEY_METADATA_INVALID', `Invalid validity metadata for signing key ${keyId}`);
  }
  return {
    publicKey: crypto.createPublicKey(entry.publicKey),
    validFrom,
    revokedAt
  };
}

function buildUnsignedEnvelope({ tenantId, executionId, sequence, evidence, previousHash, keyId, recordedAt }) {
  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId.length > 128) {
    fail('EVIDENCE_TENANT_INVALID', 'A bounded tenant identifier is required');
  }
  if (typeof executionId !== 'string' || !executionId.trim() || executionId.length > 256) {
    fail('EVIDENCE_EXECUTION_INVALID', 'A bounded execution identifier is required');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    fail('EVIDENCE_SEQUENCE_INVALID', 'Evidence sequence must be a positive safe integer');
  }
  if (!verifyEvidenceRecord(evidence) || evidence.schemaVersion !== 1 || evidence.executionId !== executionId) {
    fail('EVIDENCE_RECORD_INVALID', 'A valid evidence record for this execution is required');
  }
  if (previousHash !== null && !HASH_PATTERN.test(previousHash || '')) {
    fail('EVIDENCE_PREDECESSOR_INVALID', 'Previous record hash must be null or a SHA-256 hex digest');
  }
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    fail('EVIDENCE_KEY_ID_INVALID', 'A valid signing key identifier is required');
  }
  const timestamp = new Date(recordedAt);
  if (!Number.isFinite(timestamp.getTime())) {
    fail('EVIDENCE_TIMESTAMP_INVALID', 'A valid record timestamp is required');
  }
  return {
    schemaVersion: 1,
    tenantId,
    executionId,
    sequence,
    evidenceId: evidence.id,
    previousHash,
    keyId,
    recordedAt: timestamp.toISOString(),
    evidence
  };
}

function signEvidenceEnvelope(input, { keyId, privateKey, recordedAt = new Date().toISOString() } = {}) {
  if (!privateKey) fail('EVIDENCE_SIGNING_KEY_REQUIRED', 'A persistent Ed25519 private key is required');
  let key;
  try {
    key = crypto.createPrivateKey(privateKey);
  } catch (cause) {
    fail('EVIDENCE_SIGNING_KEY_INVALID', `Unable to load Ed25519 private key: ${cause.message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail('EVIDENCE_SIGNING_KEY_INVALID', 'Evidence signing key must use Ed25519');
  }
  const unsigned = buildUnsignedEnvelope({ ...input, keyId, recordedAt });
  const recordHash = digest(Buffer.concat([RECORD_DOMAIN, Buffer.from(canonicalJson(unsigned), 'utf8')]));
  const signature = crypto.sign(null, Buffer.from(RECORD_DOMAIN.toString('utf8') + recordHash, 'utf8'), key).toString('base64');
  return Object.freeze({ ...unsigned, recordHash, signature });
}

function verifyEvidenceEnvelope(record, trustedKeys) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        record.schemaVersion !== 1 || !HASH_PATTERN.test(record.recordHash || '') ||
        typeof record.signature !== 'string' || !record.signature.length) return false;
    const { recordHash, signature, ...unsigned } = record;
    const rebuilt = buildUnsignedEnvelope({
      tenantId: unsigned.tenantId,
      executionId: unsigned.executionId,
      sequence: unsigned.sequence,
      evidence: unsigned.evidence,
      previousHash: unsigned.previousHash,
      keyId: unsigned.keyId,
      recordedAt: unsigned.recordedAt
    });
    if (canonicalJson(rebuilt) !== canonicalJson(unsigned)) return false;
    const expectedHash = digest(Buffer.concat([RECORD_DOMAIN, Buffer.from(canonicalJson(rebuilt), 'utf8')]));
    if (recordHash !== expectedHash) return false;
    const entry = normalizeKeyEntry(trustedKeys?.[unsigned.keyId], unsigned.keyId);
    const recordedAt = new Date(unsigned.recordedAt);
    if (entry.validFrom && recordedAt < entry.validFrom) return false;
    if (entry.revokedAt && recordedAt >= entry.revokedAt) return false;
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.toString('base64') !== signature) return false;
    return crypto.verify(
      null,
      Buffer.from(RECORD_DOMAIN.toString('utf8') + recordHash, 'utf8'),
      entry.publicKey,
      signatureBytes
    );
  } catch {
    return false;
  }
}


function createEvidenceAnchor({ tenantId, executionId, sequence, recordHash, anchoredAt = new Date().toISOString() } = {}, { keyId, privateKey } = {}) {
  if (!privateKey) fail('EVIDENCE_ANCHOR_SIGNING_KEY_REQUIRED', 'A persistent external anchor signing key is required');
  let key;
  try {
    key = crypto.createPrivateKey(privateKey);
  } catch (cause) {
    fail('EVIDENCE_ANCHOR_SIGNING_KEY_INVALID', `Unable to load anchor signing key: ${cause.message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail('EVIDENCE_ANCHOR_SIGNING_KEY_INVALID', 'External anchor signing key must use Ed25519');
  }
  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId.length > 128 ||
      typeof executionId !== 'string' || !executionId.trim() || executionId.length > 256 ||
      !Number.isSafeInteger(sequence) || sequence < 1 || !HASH_PATTERN.test(recordHash || '') ||
      typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    fail('EVIDENCE_ANCHOR_INVALID', 'External anchor scope, sequence, hash, and key identifier are required');
  }
  const timestamp = new Date(anchoredAt);
  if (!Number.isFinite(timestamp.getTime())) {
    fail('EVIDENCE_ANCHOR_TIMESTAMP_INVALID', 'External anchor timestamp is invalid');
  }
  const unsigned = {
    schemaVersion: 1,
    tenantId,
    executionId,
    sequence,
    recordHash,
    keyId,
    anchoredAt: timestamp.toISOString()
  };
  const signature = crypto.sign(
    null,
    Buffer.concat([ANCHOR_DOMAIN, Buffer.from(canonicalJson(unsigned), 'utf8')]),
    key
  ).toString('base64');
  return Object.freeze({ ...unsigned, signature });
}

function verifyEvidenceAnchor(anchor, trustedKeys) {
  try {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor) ||
        anchor.schemaVersion !== 1 || typeof anchor.tenantId !== 'string' ||
        !anchor.tenantId.trim() || typeof anchor.executionId !== 'string' ||
        !anchor.executionId.trim() || !Number.isSafeInteger(anchor.sequence) ||
        anchor.sequence < 1 || !HASH_PATTERN.test(anchor.recordHash || '') ||
        typeof anchor.signature !== 'string' || !anchor.signature.length) return false;
    const { signature, ...unsigned } = anchor;
    if (typeof unsigned.keyId !== 'string' || !KEY_ID_PATTERN.test(unsigned.keyId)) return false;
    const timestamp = new Date(unsigned.anchoredAt);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== unsigned.anchoredAt) return false;
    const entry = normalizeKeyEntry(trustedKeys?.[unsigned.keyId], unsigned.keyId);
    if (entry.validFrom && timestamp < entry.validFrom) return false;
    if (entry.revokedAt && timestamp >= entry.revokedAt) return false;
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.toString('base64') !== signature) return false;
    return crypto.verify(
      null,
      Buffer.concat([ANCHOR_DOMAIN, Buffer.from(canonicalJson(unsigned), 'utf8')]),
      entry.publicKey,
      signatureBytes
    );
  } catch {
    return false;
  }
}

module.exports = {
  RECORD_DOMAIN: RECORD_DOMAIN.toString('utf8'),
  ANCHOR_DOMAIN: ANCHOR_DOMAIN.toString('utf8'),
  signEvidenceEnvelope,
  verifyEvidenceEnvelope,
  createEvidenceAnchor,
  verifyEvidenceAnchor
};
