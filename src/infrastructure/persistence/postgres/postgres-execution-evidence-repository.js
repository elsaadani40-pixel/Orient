'use strict';

const { canonicalJson, verifyEvidenceRecord } = require('../../../core/execution/evidence-record');
const { signEvidenceEnvelope, verifyEvidenceEnvelope, createEvidenceAnchor, verifyEvidenceAnchor } = require('./trusted-evidence-cryptography');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function rowToEnvelope(row) {
  return {
    schemaVersion: 1,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    sequence: Number(row.sequence),
    evidenceId: row.evidence_id,
    previousHash: row.previous_hash,
    recordHash: row.record_hash,
    keyId: row.key_id,
    signature: row.signature,
    recordedAt: new Date(row.recorded_at).toISOString(),
    evidence: row.record_payload
  };
}

class PostgresExecutionEvidenceRepository {
  constructor(db, { keyId, privateKey, trustedKeys, anchorSigning = null, trustedAnchorKeys = null, now = () => new Date() } = {}) {
    if (!db || typeof db.query !== 'function' || typeof db.transaction !== 'function' ||
        typeof db.withPrincipal !== 'function') {
      throw new TypeError('A scoped PostgresDatabase is required');
    }
    if (!keyId || !privateKey || !trustedKeys || typeof trustedKeys !== 'object') {
      throw Object.assign(new TypeError('Persistent signing key, keyId, and trusted public keys are required'), {
        code: 'EVIDENCE_SIGNING_CONFIGURATION_REQUIRED'
      });
    }
    if (typeof now !== 'function') throw new TypeError('A clock function is required');
    this.db = db;
    this.keyId = keyId;
    this.privateKey = privateKey;
    this.trustedKeys = trustedKeys;
    this.anchorSigning = anchorSigning;
    this.trustedAnchorKeys = trustedAnchorKeys;
    this.now = now;
  }

  async append(evidence, { principal, anchor = null } = {}) {
    if (!principal || typeof principal.tenantId !== 'string' || !principal.tenantId.trim()) {
      fail('EVIDENCE_PRINCIPAL_REQUIRED', 'A verified tenant principal is required');
    }
    if (!verifyEvidenceRecord(evidence)) {
      fail('EVIDENCE_RECORD_INVALID', 'Evidence record integrity verification failed');
    }

    return this.db.withPrincipal(principal, () => this.db.transaction(async client => {
      const tenantId = principal.tenantId;
      const executionId = evidence.executionId;
      const lockScope = `tenant:${tenantId.length}:${tenantId}|execution:${executionId.length}:${executionId}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockScope]);

      const chainResult = await client.query(
        `SELECT tenant_id, execution_id, sequence, evidence_id, previous_hash, record_hash,
                key_id, signature, recorded_at, record_payload
         FROM execution_evidence
         WHERE tenant_id=$1 AND execution_id=$2
         ORDER BY sequence ASC`,
        [tenantId, executionId]
      );
      let expectedSequence = 1;
      let previousHash = null;
      const verifiedChain = [];
      for (const row of chainResult.rows) {
        const current = rowToEnvelope(row);
        if (current.sequence !== expectedSequence || current.previousHash !== previousHash ||
            current.evidenceId !== current.evidence?.id ||
            !verifyEvidenceEnvelope(current, this.trustedKeys)) {
          fail('EVIDENCE_CHAIN_INVALID', 'Existing evidence chain failed verification before append');
        }
        verifiedChain.push(current);
        previousHash = current.recordHash;
        expectedSequence += 1;
      }
      if (anchor) {
        if (!verifyEvidenceAnchor(anchor, this.trustedAnchorKeys) ||
            anchor.tenantId !== tenantId || anchor.executionId !== executionId) {
          fail('EVIDENCE_ANCHOR_INVALID', 'A trusted external anchor for this tenant and execution is required');
        }
        const anchoredRecord = verifiedChain[anchor.sequence - 1];
        if (!anchoredRecord || anchoredRecord.recordHash !== anchor.recordHash) {
          fail('EVIDENCE_ANCHOR_MISMATCH', 'Persisted chain does not reach the supplied external anchor');
        }
      }

      const existing = await client.query(
        `SELECT tenant_id, execution_id, sequence, evidence_id, previous_hash, record_hash,
                key_id, signature, recorded_at, record_payload
         FROM execution_evidence
         WHERE tenant_id=$1 AND execution_id=$2 AND evidence_id=$3
         LIMIT 1`,
        [tenantId, executionId, evidence.id]
      );
      if (existing.rows.length) {
        const envelope = rowToEnvelope(existing.rows[0]);
        if (canonicalJson(envelope.evidence) !== canonicalJson(evidence) ||
            !verifyEvidenceEnvelope(envelope, this.trustedKeys)) {
          fail('EVIDENCE_IDEMPOTENCY_CONFLICT', 'Existing evidence identity has conflicting or invalid persisted content');
        }
        return envelope;
      }

      const sequence = expectedSequence;
      const previousHashForAppend = previousHash;
      const signed = signEvidenceEnvelope(
        { tenantId, executionId, sequence, evidence, previousHash: previousHashForAppend },
        { keyId: this.keyId, privateKey: this.privateKey, recordedAt: this.now().toISOString() }
      );
      const result = await client.query(
        `INSERT INTO execution_evidence
          (tenant_id, execution_id, sequence, evidence_id, previous_hash, record_hash,
           key_id, signature, recorded_at, record_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING tenant_id, execution_id, sequence, evidence_id, previous_hash, record_hash,
                   key_id, signature, recorded_at, record_payload`,
        [tenantId, executionId, sequence, evidence.id, previousHashForAppend, signed.recordHash,
          signed.keyId, signed.signature, signed.recordedAt, evidence]
      );
      const envelope = rowToEnvelope(result.rows[0]);
      if (!verifyEvidenceEnvelope(envelope, this.trustedKeys)) {
        fail('EVIDENCE_PERSISTED_RECORD_INVALID', 'Persisted evidence did not pass cryptographic verification');
      }
      return envelope;
    }));
  }

  async createAnchor(executionId, { principal } = {}) {
    if (!this.anchorSigning?.keyId || !this.anchorSigning?.privateKey) {
      fail('EVIDENCE_ANCHOR_SIGNING_CONFIGURATION_REQUIRED', 'An independently managed external anchor signing key is required');
    }
    const verification = await this.verifyExecution(executionId, { principal });
    if (!verification.valid || verification.records < 1 || !verification.headHash) {
      fail('EVIDENCE_CHAIN_NOT_ANCHORABLE', 'A non-empty valid evidence chain is required before anchoring');
    }
    return createEvidenceAnchor({
      tenantId: principal.tenantId,
      executionId,
      sequence: verification.verifiedThrough,
      recordHash: verification.headHash,
      anchoredAt: this.now().toISOString()
    }, this.anchorSigning);
  }

  async verifyExecution(executionId, { principal, anchor = null } = {}) {
    if (!principal || typeof principal.tenantId !== 'string' || !principal.tenantId.trim()) {
      fail('EVIDENCE_PRINCIPAL_REQUIRED', 'A verified tenant principal is required');
    }
    if (typeof executionId !== 'string' || !executionId.trim()) {
      fail('EVIDENCE_EXECUTION_INVALID', 'executionId is required');
    }
    return this.db.withPrincipal(principal, async () => {
      const result = await this.db.query(
        `SELECT tenant_id, execution_id, sequence, evidence_id, previous_hash, record_hash,
                key_id, signature, recorded_at, record_payload
         FROM execution_evidence
         WHERE tenant_id=$1 AND execution_id=$2
         ORDER BY sequence ASC`,
        [principal.tenantId, executionId]
      );
      let previousHash = null;
      let expectedSequence = 1;
      const records = [];
      for (const row of result.rows) {
        const envelope = rowToEnvelope(row);
        if (envelope.sequence !== expectedSequence || envelope.previousHash !== previousHash ||
            envelope.evidenceId !== envelope.evidence?.id ||
            !verifyEvidenceEnvelope(envelope, this.trustedKeys)) {
          return {
            valid: false,
            anchored: false,
            code: 'EVIDENCE_CHAIN_INVALID',
            verifiedThrough: expectedSequence - 1,
            records: records.length
          };
        }
        records.push(envelope);
        previousHash = envelope.recordHash;
        expectedSequence += 1;
      }

      if (anchor) {
        if (!verifyEvidenceAnchor(anchor, this.trustedAnchorKeys)) {
          return {
            valid: false, anchored: false, headAnchored: false,
            code: 'EVIDENCE_ANCHOR_SIGNATURE_INVALID',
            verifiedThrough: records.length, records: records.length
          };
        }
        if (anchor.tenantId !== principal.tenantId || anchor.executionId !== executionId) {
          return {
            valid: false, anchored: false, headAnchored: false,
            code: 'EVIDENCE_ANCHOR_SCOPE_INVALID',
            verifiedThrough: records.length, records: records.length
          };
        }
        const anchoredRecord = records[anchor.sequence - 1];
        if (!anchoredRecord || anchoredRecord.recordHash !== anchor.recordHash) {
          return {
            valid: false, anchored: false, headAnchored: false,
            code: 'EVIDENCE_ANCHOR_MISMATCH',
            verifiedThrough: records.length, records: records.length
          };
        }
        const headAnchored = anchor.sequence === records.length;
        return {
          valid: true,
          anchored: true,
          headAnchored,
          code: headAnchored ? 'EVIDENCE_CHAIN_VALID_AND_HEAD_ANCHORED' : 'EVIDENCE_CHAIN_VALID_ANCHORED_PREFIX',
          verifiedThrough: records.length,
          anchorSequence: anchor.sequence,
          records: records.length,
          headHash: previousHash
        };
      }

      return {
        valid: true,
        anchored: false,
        headAnchored: false,
        code: 'EVIDENCE_CHAIN_VALID_UNANCHORED',
        verifiedThrough: records.length,
        records: records.length,
        headHash: previousHash
      };
    });
  }
}

module.exports = { PostgresExecutionEvidenceRepository };
