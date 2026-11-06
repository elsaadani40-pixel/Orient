'use strict';

const { canonicalJson, verifyEvidenceRecord } = require('../../../core/execution/evidence-record');
const { signEvidenceEnvelope, verifyEvidenceEnvelope } = require('./trusted-evidence-cryptography');

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
  constructor(db, { keyId, privateKey, trustedKeys, now = () => new Date() } = {}) {
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
    this.now = now;
  }

  async append(evidence, { principal } = {}) {
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

      const latest = await client.query(
        `SELECT sequence, record_hash FROM execution_evidence
         WHERE tenant_id=$1 AND execution_id=$2
         ORDER BY sequence DESC LIMIT 1`,
        [tenantId, executionId]
      );
      const sequence = latest.rows.length ? Number(latest.rows[0].sequence) + 1 : 1;
      const previousHash = latest.rows.length ? latest.rows[0].record_hash : null;
      const signed = signEvidenceEnvelope(
        { tenantId, executionId, sequence, evidence, previousHash },
        { keyId: this.keyId, privateKey: this.privateKey, recordedAt: this.now().toISOString() }
      );
      const result = await client.query(
        `INSERT INTO execution_evidence
          (tenant_id, execution_id, sequence, evidence_id, previous_hash, record_hash,
           key_id, signature, recorded_at, record_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING tenant_id, execution_id, sequence, evidence_id, previous_hash, record_hash,
                   key_id, signature, recorded_at, record_payload`,
        [tenantId, executionId, sequence, evidence.id, previousHash, signed.recordHash,
          signed.keyId, signed.signature, signed.recordedAt, evidence]
      );
      const envelope = rowToEnvelope(result.rows[0]);
      if (!verifyEvidenceEnvelope(envelope, this.trustedKeys)) {
        fail('EVIDENCE_PERSISTED_RECORD_INVALID', 'Persisted evidence did not pass cryptographic verification');
      }
      return envelope;
    }));
  }

  async verifyExecution(executionId, { principal, anchor = null } = {}) {
    if (anchor) fail('EVIDENCE_ANCHOR_VERIFIER_REQUIRED', 'External anchors require a separately trusted signature verifier');
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

      return {
        valid: true,
        anchored: false,
        code: 'EVIDENCE_CHAIN_VALID_UNANCHORED',
        verifiedThrough: records.length,
        records: records.length,
        headHash: previousHash
      };
    });
  }
}

module.exports = { PostgresExecutionEvidenceRepository };
