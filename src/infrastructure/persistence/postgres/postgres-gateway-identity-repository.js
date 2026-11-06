'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reject(code, message) {
  throw Object.assign(new Error(message || 'Gateway identity request rejected'), { code });
}

function stableStringify(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  throw Object.assign(new TypeError('Request must contain only finite JSON values'), { code: 'GATEWAY_REQUEST_NOT_JSON' });
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function validateBinding(binding) {
  if (!binding || !UUID.test(binding.ownerId || '') || !UUID.test(binding.sessionId || '') ||
      !UUID.test(binding.challengeId || '') || !UUID.test(binding.operationId || '') ||
      !UUID.test(binding.requestId || '') || typeof binding.tenantId !== 'string' ||
      !binding.tenantId.trim() || binding.tenantId.length > 128 ||
      typeof binding.workspaceId !== 'string' || !binding.workspaceId.trim() ||
      binding.workspaceId.length > 128 || typeof binding.operation !== 'string' ||
      !binding.operation.trim() || binding.operation.length > 128) {
    reject('GATEWAY_BINDING_INVALID');
  }
}

class PostgresGatewayIdentityRepository {
  constructor(db, { now = () => Date.now() } = {}) {
    if (!db || typeof db.query !== 'function' || typeof db.transaction !== 'function' ||
        typeof db.withPrincipal !== 'function') throw new TypeError('A scoped PostgresDatabase is required');
    if (typeof now !== 'function') throw new TypeError('A clock function is required');
    this.db = db;
    this.now = now;
  }

  async issue(challenge, { principal } = {}) {
    validateBinding(challenge);
    if (!principal || principal.ownerId !== challenge.ownerId ||
        principal.principalId !== challenge.ownerId || principal.sessionId !== challenge.sessionId ||
        principal.tenantId !== challenge.tenantId || principal.workspaceId !== challenge.workspaceId) {
      reject('GATEWAY_PRINCIPAL_BINDING_MISMATCH');
    }
    return this.db.withPrincipal(principal, async () => {
    const now = this.now();
    const expiresAt = challenge.expiresAt;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      reject('GATEWAY_CHALLENGE_EXPIRY_INVALID');
    }
    const issuedAt = new Date(now).toISOString();
    const result = await this.db.query(
      `INSERT INTO gateway_challenges
       (challenge_id,owner_id,session_id,tenant_id,workspace_id,operation,operation_id,request_id,status,issued_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ISSUED',$9,$10)
       RETURNING challenge_id`,
      [challenge.challengeId,challenge.ownerId,challenge.sessionId,challenge.tenantId,
        challenge.workspaceId,challenge.operation,challenge.operationId,challenge.requestId,
        issuedAt,new Date(expiresAt).toISOString()]
    );
    return result.rows[0]?.challenge_id || null;
    });
  }

  async getForIssuance(challengeId, { principal } = {}) {
    if (!UUID.test(challengeId || '')) return null;
    if (!principal || !UUID.test(principal.ownerId || '') ||
        principal.principalId !== principal.ownerId || !UUID.test(principal.sessionId || '') ||
        typeof principal.tenantId !== 'string' || !principal.tenantId.trim() ||
        typeof principal.workspaceId !== 'string' || !principal.workspaceId.trim()) {
      reject('GATEWAY_PRINCIPAL_REQUIRED');
    }
    return this.db.withPrincipal(principal, async () => {
    const result = await this.db.query(
      `SELECT challenge_id,owner_id,session_id,tenant_id,workspace_id,operation,
              operation_id,request_id,status,issued_at,expires_at,consumed_at
       FROM gateway_challenges
       WHERE challenge_id=$1 AND owner_id=$2 AND session_id=$3
         AND tenant_id=$4 AND workspace_id=$5 LIMIT 1`,
      [challengeId,principal.ownerId,principal.sessionId,principal.tenantId,principal.workspaceId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      challengeId: row.challenge_id,
      ownerId: row.owner_id,
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      operation: row.operation,
      operationId: row.operation_id,
      requestId: row.request_id,
      status: row.status,
      issuedAt: new Date(row.issued_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime(),
      consumedAt: row.consumed_at ? new Date(row.consumed_at).getTime() : null
    };
    });
  }

  /**
   * Executes a database-only protected mutation in the same transaction that
   * consumes its one-time challenge and stores its idempotent response.
   * The callback MUST NOT perform network calls or other external side effects.
   */
  async executeAtomically({ principal, binding, idempotencyKey, request, execute } = {}) {
    validateBinding(binding);
    if (!principal || principal.ownerId !== binding.ownerId ||
        principal.principalId !== binding.ownerId || principal.sessionId !== binding.sessionId ||
        principal.tenantId !== binding.tenantId || principal.workspaceId !== binding.workspaceId) {
      reject('GATEWAY_PRINCIPAL_BINDING_MISMATCH');
    }
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() ||
        idempotencyKey.length > 200 || typeof execute !== 'function') {
      reject('GATEWAY_IDEMPOTENCY_INPUT_INVALID');
    }
    const requestFingerprint = fingerprint({
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
      tenantId: binding.tenantId,
      workspaceId: binding.workspaceId,
      operation: binding.operation,
      operationId: binding.operationId,
      requestId: binding.requestId,
      request
    });

    return this.db.withPrincipal(principal, () => this.db.transaction(async client => {
      const challengeResult = await client.query(
        `SELECT * FROM gateway_challenges
         WHERE challenge_id=$1 AND tenant_id=$2 AND owner_id=$3 AND session_id=$4
           AND workspace_id=$5 AND operation=$6 AND operation_id=$7 AND request_id=$8
         FOR UPDATE`,
        [binding.challengeId,binding.tenantId,binding.ownerId,binding.sessionId,
          binding.workspaceId,binding.operation,binding.operationId,binding.requestId]
      );
      if (!challengeResult.rows.length) reject('GATEWAY_CHALLENGE_REJECTED');
      const challenge = challengeResult.rows[0];

      const existingResult = await client.query(
        'SELECT * FROM gateway_idempotency WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [binding.tenantId,idempotencyKey]
      );
      if (existingResult.rows.length) {
        const existing = existingResult.rows[0];
        if (existing.request_fingerprint !== requestFingerprint ||
            existing.owner_id !== binding.ownerId || existing.session_id !== binding.sessionId ||
            existing.challenge_id !== binding.challengeId || existing.operation !== binding.operation ||
            existing.operation_id !== binding.operationId || existing.request_id !== binding.requestId) {
          reject('GATEWAY_IDEMPOTENCY_CONFLICT');
        }
        if (existing.status === 'COMPLETED') {
          return { replayed: true, response: existing.response };
        }
        reject('GATEWAY_IDEMPOTENCY_IN_PROGRESS');
      }

      if (challenge.status !== 'ISSUED' || new Date(challenge.expires_at).getTime() <= this.now()) {
        reject('GATEWAY_CHALLENGE_REPLAY_REJECTED');
      }

      const createdAt = new Date(this.now()).toISOString();
      const inserted = await client.query(
        `INSERT INTO gateway_idempotency
         (tenant_id,idempotency_key,request_fingerprint,owner_id,session_id,challenge_id,
          operation,operation_id,request_id,status,response,created_at,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RUNNING',NULL,$10,NULL)
         ON CONFLICT DO NOTHING RETURNING idempotency_key`,
        [binding.tenantId,idempotencyKey,requestFingerprint,binding.ownerId,binding.sessionId,
          binding.challengeId,binding.operation,binding.operationId,binding.requestId,createdAt]
      );
      if (inserted.rowCount !== 1) reject('GATEWAY_IDEMPOTENCY_CONFLICT');

      const consumedAt = new Date(this.now()).toISOString();
      const consumed = await client.query(
        `UPDATE gateway_challenges SET status='CONSUMED',consumed_at=$1
         WHERE challenge_id=$2 AND tenant_id=$3 AND status='ISSUED' AND expires_at>$1
         RETURNING challenge_id`,
        [consumedAt,binding.challengeId,binding.tenantId]
      );
      if (consumed.rowCount !== 1) reject('GATEWAY_CHALLENGE_REPLAY_REJECTED');

      const response = await execute(client);
      let serialized;
      try {
        serialized = JSON.stringify(response === undefined ? null : response);
        if (serialized === undefined) reject('GATEWAY_RESPONSE_NOT_SERIALIZABLE');
      } catch (error) {
        if (error.code === 'GATEWAY_RESPONSE_NOT_SERIALIZABLE') throw error;
        reject('GATEWAY_RESPONSE_NOT_SERIALIZABLE');
      }
      const completedAt = new Date(this.now()).toISOString();
      const completed = await client.query(
        `UPDATE gateway_idempotency SET status='COMPLETED',response=$1::jsonb,completed_at=$2
         WHERE tenant_id=$3 AND idempotency_key=$4 AND status='RUNNING'`,
        [serialized,completedAt,binding.tenantId,idempotencyKey]
      );
      if (completed.rowCount !== 1) reject('GATEWAY_IDEMPOTENCY_COMPLETION_CONFLICT');
      return { replayed: false, response: response === undefined ? null : response };
    }));
  }
}

module.exports = { PostgresGatewayIdentityRepository, fingerprint };
