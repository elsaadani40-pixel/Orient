const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { validateAcknowledgement, prepareAcknowledgement } = require('../workflow-outbox-utils');
const { assertPersistencePrincipal } = require('../../../core/security/persistence-principal');
const { assertWorkerPersistencePrincipal } = require('../../../core/security/worker-persistence-principal');
const { PostgresDatabase } = require('./postgres-database');
const PostgresTenantQuotaRepository = require('./postgres-tenant-quota-repository');
const PostgresWorkerRegistryRepository = require('./postgres-worker-registry-repository');
const PostgresOwnerChatConversationRepository = require('./postgres-owner-chat-conversation-repository');
const PostgresOwnerWorkProfileRepository = require('./postgres-owner-work-profile-repository');

function tenantOrLocal(value) {
  return value || 'local';
}

function assertTenant(actual, expected, label) {
  if (expected && actual !== expected) {
    const error = new Error(`${label} tenant mismatch`);
    error.code = 'TENANT_PERSISTENCE_MISMATCH';
    throw error;
  }
}

async function withPersistencePrincipal(db, persistencePrincipal, tenantId, label, work) {
  if (!persistencePrincipal) return work({ query: (sql, values) => db.query(sql, values) });
  const principal = assertPersistencePrincipal(persistencePrincipal);
  assertTenant(principal.tenantId, tenantOrLocal(tenantId), label);
  if (typeof db.transactionWithPrincipal !== 'function') {
    throw Object.assign(new Error('Principal-scoped PostgreSQL transactions are required'), {
      code: 'PRINCIPAL_TRANSACTION_REQUIRED'
    });
  }
  return db.transactionWithPrincipal(principal, work);
}

class PostgresExecutionRepository {
  constructor(db) { this.db = db; }

  async findById(executionId, { tenantId = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Execution principal', async client => {
      const values = effectiveTenant ? [executionId, effectiveTenant] : [executionId];
      let where = effectiveTenant ? 'AND tenant_id=$2' : '';
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += ' AND payload->>\'userId\'=$' + values.length;
      }
      const result = await client.query(
        `SELECT payload FROM executions WHERE execution_id=$1 ${where} LIMIT 1`,
        values
      );
      return result.rows.length ? result.rows[0].payload : null;
    });
  }

  async findAll({ tenantId = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Execution principal', async client => {
      const values = effectiveTenant ? [effectiveTenant] : [];
      let where = effectiveTenant ? 'WHERE tenant_id=$1' : '';
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += (where ? ' AND ' : 'WHERE ') + 'payload->>\'userId\'=$' + values.length;
      }
      const result = await client.query(
        'SELECT payload FROM executions ' + where + ' ORDER BY updated_at DESC',
        values
      );
      return result.rows.map(row => row.payload);
    });
  }

  async findPage({ tenantId = null, limit = 50, offset = 0, persistencePrincipal = null } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
    const boundedOffset = Number.isInteger(offset) ? Math.max(0, Math.min(offset, 10000)) : 0;
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Execution principal', async client => {
      const values = effectiveTenant ? [effectiveTenant] : [];
      let where = effectiveTenant ? 'WHERE tenant_id=$1' : '';
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += (where ? ' AND ' : 'WHERE ') + 'payload->>\'userId\'=$' + values.length;
      }
      const countResult = await client.query('SELECT COUNT(*)::int AS total FROM executions ' + where, values);
      const pageValues = [...values, boundedLimit, boundedOffset];
      const pageResult = await client.query(
        'SELECT payload FROM executions ' + where +
        ' ORDER BY updated_at DESC, execution_id DESC LIMIT $' + (values.length + 1) +
        ' OFFSET $' + (values.length + 2),
        pageValues
      );
      return {
        total: Number(countResult.rows[0]?.total || 0),
        limit: boundedLimit,
        offset: boundedOffset,
        executions: pageResult.rows.map(row => row.payload)
      };
    });
  }

  async findByGoalId(goalId, { tenantId = null } = {}) {
    const result = await this.db.query(tenantId ? 'SELECT payload FROM executions WHERE tenant_id=$1 AND payload->>\'goalId\'=$2 ORDER BY updated_at DESC' : 'SELECT payload FROM executions WHERE payload->>\'goalId\'=$1 ORDER BY updated_at DESC', tenantId ? [tenantId,goalId] : [goalId]); return result.rows.map(row => row.payload);
  }

  async insert(execution, { tenantId = null, persistencePrincipal = null } = {}) {
    const generatedExecutionId = execution.id || execution.executionId || crypto.randomUUID();
    const normalized = {
      ...execution,
      id: generatedExecutionId,
      executionId: generatedExecutionId,
      executionVersion: Number(execution.executionVersion || 1),
      status: execution.status || 'created',
      agentLifecycle: execution.agentLifecycle || 'created',
      metadata: execution.metadata && typeof execution.metadata === 'object' ? { ...execution.metadata } : {},
      steps: Array.isArray(execution.steps) ? [...execution.steps] : [],
      observations: Array.isArray(execution.observations) ? [...execution.observations] : [],
      events: Array.isArray(execution.events) ? [...execution.events] : [],
      updatedAt: execution.updatedAt || new Date().toISOString(),
      cancellationRequested: Boolean(execution.cancellationRequested),
      cancellationReason: execution.cancellationReason || null
    };
    const effectiveTenant = tenantOrLocal(normalized.tenantId || normalized.metadata.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Execution');
    normalized.tenantId = effectiveTenant;
    if (persistencePrincipal && normalized.userId !== persistencePrincipal.ownerId) {
      throw Object.assign(new Error('Execution owner does not match persistence principal'), {
        code: 'PERSISTENCE_PRINCIPAL_MISMATCH'
      });
    }
    await withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Execution principal', client =>
      client.query(
        'INSERT INTO executions(execution_id,tenant_id,payload,updated_at) VALUES($1,$2,$3,$4)',
        [normalized.executionId, effectiveTenant, normalized, normalized.updatedAt]
      )
    );
    return normalized;
  }

  async update(executionId, patch, { tenantId = null, persistencePrincipal = null } = {}) {
    let requestedTenant = tenantId || patch?.tenantId;
    if (!requestedTenant && !persistencePrincipal) {
      const existing = await this.findById(executionId);
      requestedTenant = existing?.tenantId || existing?.metadata?.tenantId || 'local';
    }
    const effectiveTenant = tenantOrLocal(requestedTenant);
    if (persistencePrincipal) assertTenant(persistencePrincipal.tenantId, effectiveTenant, 'Execution principal');
    if (persistencePrincipal && patch?.userId && patch.userId !== persistencePrincipal.ownerId) {
      throw Object.assign(new Error('Execution owner does not match persistence principal'), {
        code: 'PERSISTENCE_PRINCIPAL_MISMATCH'
      });
    }
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Execution principal', async client => {
      const ownerClause = persistencePrincipal ? " AND payload->>'userId'=$3" : '';
      const values = persistencePrincipal ? [executionId, effectiveTenant, persistencePrincipal.ownerId] : [executionId, effectiveTenant];
      const selected = await client.query(
        'SELECT payload FROM executions WHERE execution_id=$1 AND tenant_id=$2' + ownerClause + ' LIMIT 1',
        values
      );
      if (!selected.rows.length) return null;
      const current = selected.rows[0].payload;
      const updated = {
        ...current, ...patch,
        ...(current.cancellationRequested ? { cancellationRequested: true, cancellationReason: current.cancellationReason || patch.cancellationReason || null } : {}),
        id: current.id,
        executionId: current.executionId,
        tenantId: effectiveTenant,
        updatedAt: new Date().toISOString()
      };
      const updateValues = [executionId, effectiveTenant, updated, updated.updatedAt, patch.status || ''];
      const updateOwnerClause = persistencePrincipal ? ' AND payload->>\'userId\'=$6' : '';
      if (persistencePrincipal) updateValues.push(persistencePrincipal.ownerId);
      const result = await client.query(
        `UPDATE executions
         SET payload=$3, updated_at=$4
         WHERE execution_id=$1
           AND tenant_id=$2${updateOwnerClause}
           AND NOT (
             COALESCE(payload->>'cancellationRequested', 'false') = 'true'
             AND $5::text IN ('completed', 'failed')
           )
         RETURNING payload`,
        updateValues
      );
      if (result.rows.length) return result.rows[0].payload;
      const latest = await client.query(
        'SELECT payload FROM executions WHERE execution_id=$1 AND tenant_id=$2' + ownerClause + ' LIMIT 1',
        values
      );
      return latest.rows.length ? latest.rows[0].payload : null;
    });
  }

  async requestCancellation(executionId, reason = 'Execution cancellation requested', { tenantId = null, persistencePrincipal = null } = {}) {
    if (!executionId) throw new TypeError('executionId is required');
    const effectiveTenant = tenantOrLocal(tenantId);
    const updatedAt = new Date().toISOString();
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Execution principal', async client => {
      const ownerClause = persistencePrincipal ? " AND payload->>'userId'=$5" : '';
      const values = [
        executionId,
        effectiveTenant,
        String(reason || 'Execution cancellation requested'),
        updatedAt
      ];
      if (persistencePrincipal) values.push(persistencePrincipal.ownerId);
      const result = await client.query(
        `UPDATE executions
         SET payload = jsonb_set(
           jsonb_set(payload, '{cancellationRequested}', 'true'::jsonb, true),
           '{cancellationReason}', to_jsonb($3::text), true
         ),
         updated_at = $4
         WHERE execution_id=$1
           AND tenant_id=$2${ownerClause}
           AND COALESCE(payload->>'status','created') NOT IN ('completed','failed','cancelled')
         RETURNING payload`,
        values
      );
      if (result.rows.length) return result.rows[0].payload;
      const latest = await client.query(
        'SELECT payload FROM executions WHERE execution_id=$1 AND tenant_id=$2' +
        (persistencePrincipal ? " AND payload->>'userId'=$3" : '') + ' LIMIT 1',
        persistencePrincipal ? [executionId, effectiveTenant, persistencePrincipal.ownerId] : [executionId, effectiveTenant]
      );
      return latest.rows.length ? latest.rows[0].payload : null;
    });
  }

  async deleteById(executionId, { tenantId = null } = {}) {
    const result = await this.db.query(
      tenantId
        ? 'DELETE FROM executions WHERE execution_id=$1 AND tenant_id=$2'
        : 'DELETE FROM executions WHERE execution_id=$1',
      tenantId ? [executionId, tenantId] : [executionId]
    );
    return result.rowCount === 1;
  }

  async count({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT COUNT(*)::int AS count FROM executions WHERE tenant_id=$1', [tenantId])
      : await this.db.query('SELECT COUNT(*)::int AS count FROM executions');
    return Number(result.rows[0].count);
  }
}

class PostgresEventRepository {
  constructor(db) { this.db = db; }

  normalize(event, tenantId) {
    const effectiveTenant = tenantOrLocal(event.data?.tenantId || tenantId);
    assertTenant(effectiveTenant, tenantId, 'Event');
    return {
      id: event.id || crypto.randomUUID(),
      type: event.type,
      executionId: event.executionId || null,
      goalId: event.goalId || null,
      aggregateId: event.aggregateId || event.workflowId || null,
      sequence: event.sequence == null ? null : Number(event.sequence),
      timestamp: event.timestamp || new Date().toISOString(),
      data: { ...(event.data || {}), tenantId: effectiveTenant }
    };
  }

  async append(event, { tenantId = null, persistencePrincipal = null } = {}) {
    const inserted = await this.appendMany([event], { tenantId, ...(persistencePrincipal ? { persistencePrincipal } : {}) });
    return inserted[0] || this.normalize(event, tenantId);
  }

  async appendMany(events, { tenantId = null, persistencePrincipal = null } = {}) {
    const inserted = [];
    const effectiveTenant = tenantOrLocal(tenantId);
    const persist = async client => {
      for (const event of events || []) {
        const normalized = this.normalize(event, effectiveTenant);
        if (persistencePrincipal) {
          if (!normalized.executionId) {
            throw Object.assign(new Error('Owner-scoped events require an execution ID'), {
              code: 'PERSISTENCE_PRINCIPAL_MISMATCH'
            });
          }
          const ownerExecution = await client.query(
            "SELECT 1 FROM executions WHERE execution_id=$1 AND tenant_id=$2 AND payload->>'userId'=$3 LIMIT 1",
            [normalized.executionId, effectiveTenant, persistencePrincipal.ownerId]
          );
          if (!ownerExecution.rows.length) {
            throw Object.assign(new Error('Event execution is not owned by the persistence principal'), {
              code: 'PERSISTENCE_PRINCIPAL_MISMATCH'
            });
          }
        }
        const result = await client.query(
          `INSERT INTO events(event_id,tenant_id,execution_id,goal_id,type,timestamp,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(event_id) DO NOTHING`,
          [normalized.id, normalized.data.tenantId, normalized.executionId, normalized.goalId, normalized.type, normalized.timestamp, normalized]
        );
        if (result.rowCount === 1) inserted.push(normalized);
        else {
          const existing = await client.query(
            'SELECT tenant_id,payload FROM events WHERE event_id=$1 LIMIT 1',
            [normalized.id]
          );
          const prior = existing.rows[0]?.payload;
          if (!prior || existing.rows[0].tenant_id !== normalized.data.tenantId ||
              prior.type !== normalized.type || prior.executionId !== normalized.executionId ||
              prior.goalId !== normalized.goalId || (event.timestamp && prior.timestamp !== normalized.timestamp) ||
              !isDeepStrictEqual(prior.data || {}, normalized.data || {})) {
            throw Object.assign(new Error('Event identity conflict'), { code: 'EVENT_ID_CONFLICT' });
          }
        }
      }
    };
    if (persistencePrincipal) {
      await withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Event principal', persist);
    } else {
      await this.db.transaction(persist);
    }
    return inserted;
  }

  async appendMissionEvent(event, { tenantId = null, workerPrincipal = null, persistencePrincipal = null } = {}) {
    if (!event?.aggregateId) throw new TypeError('aggregateId is required');
    if (workerPrincipal && persistencePrincipal) {
      throw Object.assign(new Error('Mission event writes must use either worker lease authority or owner authority, not both'), {
        code: 'MISSION_EVENT_AUTHORITY_AMBIGUOUS'
      });
    }
    const effectiveTenant = tenantOrLocal(tenantId || persistencePrincipal?.tenantId);
    const owner = persistencePrincipal ? assertPersistencePrincipal(persistencePrincipal) : null;
    if (owner && owner.tenantId !== effectiveTenant) {
      throw Object.assign(new Error('Mission event tenant does not match the owner principal'), {
        code: 'PERSISTENCE_PRINCIPAL_MISMATCH'
      });
    }
    const compareTimestamp = typeof event.timestamp === 'string' && event.timestamp.length > 0;
    const normalized = this.normalize(event, effectiveTenant);
    const persist = async client => {
      if (owner) {
        const ownedWorkflow = await client.query(
          "SELECT 1 FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 AND payload->>'userId'=$3 FOR UPDATE",
          [normalized.aggregateId, effectiveTenant, owner.ownerId]
        );
        if (!ownedWorkflow.rowCount) {
          throw Object.assign(new Error('Workflow not found for the authenticated owner'), {
            code: 'WORKFLOW_NOT_FOUND'
          });
        }
        const activeClaim = await client.query(
          'SELECT 1 FROM workflow_dispatch_claims WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at>NOW() LIMIT 1',
          [normalized.aggregateId, effectiveTenant]
        );
        if (activeClaim.rowCount) {
          throw Object.assign(new Error('Mission event append rejected while a worker dispatch claim is active'), {
            code: 'WORKFLOW_DISPATCH_CLAIM_HELD'
          });
        }
        const activeLease = await client.query(
          'SELECT 1 FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at>NOW() LIMIT 1',
          [normalized.aggregateId, effectiveTenant]
        );
        if (activeLease.rowCount) {
          throw Object.assign(new Error('Mission event append rejected while a worker lease is active'), {
            code: 'WORKFLOW_LEASE_HELD'
          });
        }
      }
      if (workerPrincipal) {
        const principal = assertWorkerPersistencePrincipal(workerPrincipal, { requireLease: true });
        if (principal.tenantId !== normalized.data.tenantId ||
            principal.workflowId !== normalized.aggregateId) {
          throw Object.assign(new Error('Worker principal does not match mission event identity'), {
            code: 'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH'
          });
        }
        const worker = await client.query(
          `SELECT 1 FROM worker_nodes
           WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3
             AND status='READY' AND expires_at > NOW()
           FOR UPDATE`,
          [principal.tenantId, principal.workerId, principal.sessionId]
        );
        if (worker.rowCount !== 1) {
          throw Object.assign(new Error('Worker session is no longer active'), { code: 'WORKER_SESSION_LOST' });
        }
        const lease = await client.query(
          `SELECT 1 FROM workflow_leases
           WHERE tenant_id=$1 AND workflow_id=$2 AND lease_id=$3
             AND worker_id=$4 AND worker_session_id=$5
             AND fencing_token=$6 AND expires_at > NOW()
           FOR UPDATE`,
          [principal.tenantId, principal.workflowId, principal.leaseId,
            principal.workerId, principal.sessionId, principal.fencingToken]
        );
        if (lease.rowCount !== 1) {
          throw Object.assign(new Error('Mission event rejected by durable worker fencing'), {
            code: 'WORKFLOW_FENCING_REJECTED'
          });
        }
      }
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [normalized.data.tenantId, normalized.aggregateId]
      );
      const existing = await client.query(
        'SELECT tenant_id,aggregate_id,payload FROM events WHERE event_id=$1 LIMIT 1',
        [normalized.id]
      );
      if (existing.rows.length) {
        const row = existing.rows[0];
        const prior = row.payload;
        if (row.tenant_id !== normalized.data.tenantId || row.aggregate_id !== normalized.aggregateId ||
            prior.type !== normalized.type || prior.executionId !== normalized.executionId ||
            prior.goalId !== normalized.goalId || (compareTimestamp && prior.timestamp !== normalized.timestamp) ||
            !isDeepStrictEqual(prior.data || {}, normalized.data || {})) {
          throw Object.assign(new Error('Mission event identity conflict'), { code: 'MISSION_EVENT_ID_CONFLICT' });
        }
        return prior;
      }
      const sequenceResult = await client.query(
        'SELECT COALESCE(MAX(sequence),0)::bigint + 1 AS next_sequence FROM events WHERE tenant_id=$1 AND aggregate_id=$2',
        [normalized.data.tenantId, normalized.aggregateId]
      );
      normalized.sequence = Number(sequenceResult.rows[0].next_sequence);
      const inserted = await client.query(
        `INSERT INTO events(event_id,tenant_id,execution_id,goal_id,aggregate_id,sequence,type,timestamp,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(event_id) DO NOTHING RETURNING payload`,
        [normalized.id, normalized.data.tenantId, normalized.executionId, normalized.goalId,
          normalized.aggregateId, normalized.sequence, normalized.type, normalized.timestamp, normalized]
      );
      if (inserted.rowCount === 1) return inserted.rows[0].payload;
      const raced = await client.query(
        'SELECT tenant_id,aggregate_id,payload FROM events WHERE event_id=$1 LIMIT 1',
        [normalized.id]
      );
      const prior = raced.rows[0]?.payload;
      if (!prior || raced.rows[0].tenant_id !== normalized.data.tenantId ||
          raced.rows[0].aggregate_id !== normalized.aggregateId || prior.type !== normalized.type ||
          prior.executionId !== normalized.executionId || prior.goalId !== normalized.goalId ||
          (compareTimestamp && prior.timestamp !== normalized.timestamp) ||
          !isDeepStrictEqual(prior.data || {}, normalized.data || {})) {
        throw Object.assign(new Error('Mission event identity conflict'), { code: 'MISSION_EVENT_ID_CONFLICT' });
      }
      return prior;
    };
    if (workerPrincipal) {
      return this.db.transactionWithWorkerPrincipal(workerPrincipal, persist, { requireLease: true });
    }
    if (owner) {
      return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Mission event principal', persist);
    }
    return this.db.transaction(persist);
  }

  async findByAggregateId(id, { tenantId = null } = {}) {
    if (!id) return [];
    const result = tenantId
      ? await this.db.query(
        'SELECT payload FROM events WHERE tenant_id=$1 AND aggregate_id=$2 ORDER BY sequence ASC',
        [tenantId, id]
      )
      : await this.db.query(
        'SELECT payload FROM events WHERE aggregate_id=$1 ORDER BY tenant_id ASC,sequence ASC',
        [id]
      );
    return result.rows.map(row => row.payload);
  }

  async findAll({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT payload FROM events WHERE tenant_id=$1 ORDER BY timestamp ASC', [tenantId])
      : await this.db.query('SELECT payload FROM events ORDER BY timestamp ASC');
    return result.rows.map(row => row.payload);
  }

  async findByExecutionId(id, { tenantId = null, limit = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Event principal', async client => {
      const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : null;
      if (!persistencePrincipal) {
        if (boundedLimit) {
          const result = await client.query(
            effectiveTenant
              ? 'SELECT payload FROM (SELECT payload,timestamp,event_id FROM events WHERE tenant_id=$1 AND execution_id=$2 ORDER BY timestamp DESC,event_id DESC LIMIT $3) recent ORDER BY timestamp ASC,event_id ASC'
              : 'SELECT payload FROM (SELECT payload,timestamp,event_id FROM events WHERE execution_id=$1 ORDER BY timestamp DESC,event_id DESC LIMIT $2) recent ORDER BY timestamp ASC,event_id ASC',
            effectiveTenant ? [effectiveTenant, id, boundedLimit] : [id, boundedLimit]
          );
          return result.rows.map(row => row.payload);
        }
        const result = await client.query(
          effectiveTenant
            ? 'SELECT payload FROM events WHERE tenant_id=$1 AND execution_id=$2 ORDER BY timestamp ASC,event_id ASC'
            : 'SELECT payload FROM events WHERE execution_id=$1 ORDER BY timestamp ASC,event_id ASC',
          effectiveTenant ? [effectiveTenant, id] : [id]
        );
        return result.rows.map(row => row.payload);
      }

      const values = [effectiveTenant, id, persistencePrincipal.ownerId];
      const ownerClause = " AND EXISTS (SELECT 1 FROM executions x WHERE x.execution_id=events.execution_id AND x.tenant_id=events.tenant_id AND x.payload->>'userId'=$3)";
      if (boundedLimit) {
        values.push(boundedLimit);
        const result = await client.query(
          'SELECT payload FROM (SELECT payload,timestamp,event_id FROM events WHERE tenant_id=$1 AND execution_id=$2' +
          ownerClause + ' ORDER BY timestamp DESC,event_id DESC LIMIT $4) recent ORDER BY timestamp ASC,event_id ASC',
          values
        );
        return result.rows.map(row => row.payload);
      }
      const result = await client.query(
        'SELECT payload FROM events WHERE tenant_id=$1 AND execution_id=$2' +
        ownerClause + ' ORDER BY timestamp ASC,event_id ASC',
        values
      );
      return result.rows.map(row => row.payload);
    });
  }

  async findByGoalId(id, { tenantId = null } = {}) {
    const result = await this.db.query(tenantId ? 'SELECT payload FROM events WHERE tenant_id=$1 AND goal_id=$2 ORDER BY timestamp ASC' : 'SELECT payload FROM events WHERE goal_id=$1 ORDER BY timestamp ASC', tenantId ? [tenantId,id] : [id]); return result.rows.map(row => row.payload);
  }

  async findByType(type, { tenantId = null } = {}) {
    const result = await this.db.query(tenantId ? 'SELECT payload FROM events WHERE tenant_id=$1 AND type=$2 ORDER BY timestamp ASC' : 'SELECT payload FROM events WHERE type=$1 ORDER BY timestamp ASC', tenantId ? [tenantId,type] : [type]); return result.rows.map(row => row.payload);
  }

  async count({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT COUNT(*)::int AS count FROM events WHERE tenant_id=$1', [tenantId])
      : await this.db.query('SELECT COUNT(*)::int AS count FROM events');
    return Number(result.rows[0].count);
  }
}

class PostgresIdempotencyRepository {
  constructor(db) { this.db = db; }

  buildKey({ executionId, step, tool, planRevision = 1, operationId = null } = {}) {
    if (!executionId) throw new TypeError('executionId is required');
    if (step === undefined || step === null) throw new TypeError('step is required');
    if (!tool) throw new TypeError('tool is required');
    return operationId || `${executionId}:plan-${planRevision}:step-${step}:${tool}`;
  }

  async withPrincipal(persistencePrincipal, tenantId, work) {
    if (!persistencePrincipal) {
      return work({ query: (sql, values) => this.db.query(sql, values) });
    }
    const principal = assertPersistencePrincipal(persistencePrincipal);
    assertTenant(principal.tenantId, tenantId, 'Idempotency principal');
    if (typeof this.db.transactionWithPrincipal !== 'function') {
      throw Object.assign(new Error('Principal-scoped PostgreSQL transactions are required'), {
        code: 'PRINCIPAL_TRANSACTION_REQUIRED'
      });
    }
    return this.db.transactionWithPrincipal(principal, work);
  }

  async findByKey(key, { tenantId = 'local', persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantOrLocal(tenantId);
    return this.withPrincipal(persistencePrincipal, effectiveTenant, async client => {
      const result = await client.query(
        'SELECT payload FROM idempotency WHERE key=$1 AND tenant_id=$2 LIMIT 1',
        [key, effectiveTenant]
      );
      if (!result.rows.length) return null;
      const record = result.rows[0].payload;
      assertTenant(tenantOrLocal(record.tenantId), effectiveTenant, 'Idempotency');
      return record;
    });
  }

  async find(args) {
    return this.findByKey(this.buildKey(args), {
      tenantId: args?.tenantId || 'local',
      persistencePrincipal: args?.persistencePrincipal || null
    });
  }

  async begin(args) {
    const key = this.buildKey(args);
    const tenantId = tenantOrLocal(args?.tenantId);
    const record = {
      id: crypto.randomUUID(), key,
      executionId: args.executionId, step: args.step, tool: args.tool,
      planRevision: args.planRevision || 1, operationId: args.operationId || null,
      tenantId, status: 'running', result: null, error: null,
      startedAt: new Date().toISOString(), completedAt: null
    };
    return this.withPrincipal(args.persistencePrincipal || null, tenantId, async client => {
      const result = await client.query(
        `INSERT INTO idempotency(key,tenant_id,payload,status,updated_at)
         VALUES($1,$2,$3,'running',$4)
         ON CONFLICT(tenant_id,key) DO NOTHING`,
        [key, tenantId, record, record.startedAt]
      );
      if (result.rowCount === 1) return { created: true, key, record };
      const existing = await client.query(
        'SELECT payload FROM idempotency WHERE key=$1 AND tenant_id=$2 LIMIT 1',
        [key, tenantId]
      );
      const existingRecord = existing.rows.length ? existing.rows[0].payload : null;
      if (existingRecord) assertTenant(tenantOrLocal(existingRecord.tenantId), tenantId, 'Idempotency');
      return { created: false, key, record: existingRecord };
    });
  }

  async complete(key, result, { tenantId = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantOrLocal(tenantId);
    return this.withPrincipal(persistencePrincipal, effectiveTenant, async client => {
      const selected = await client.query(
        'SELECT payload FROM idempotency WHERE key=$1 AND tenant_id=$2 LIMIT 1',
        [key, effectiveTenant]
      );
      if (!selected.rows.length) return null;
      const record = selected.rows[0].payload;
      assertTenant(tenantOrLocal(record.tenantId), effectiveTenant, 'Idempotency');
      if (record.status === 'completed') {
        if (JSON.stringify(record.result) !== JSON.stringify(result ?? null)) {
          const error = new Error('Idempotency record is already completed with a different result');
          error.code = 'IDEMPOTENCY_TERMINAL_CONFLICT'; error.status = 409; throw error;
        }
        return record;
      }
      if (record.status !== 'running') {
        const error = new Error('Idempotency record is not running');
        error.code = 'IDEMPOTENCY_TERMINAL_CONFLICT'; error.status = 409; throw error;
      }
      record.status = 'completed';
      record.result = result ?? null;
      record.completedAt = new Date().toISOString();
      const updated = await client.query(
        'UPDATE idempotency SET payload=$3,status=$4,updated_at=$5 WHERE key=$1 AND tenant_id=$2 AND status=$6',
        [key, effectiveTenant, record, record.status, record.completedAt, 'running']
      );
      if (updated.rowCount !== 1) {
        const error = new Error('Idempotency terminal transition lost a race');
        error.code = 'IDEMPOTENCY_TERMINAL_CONFLICT'; error.status = 409; throw error;
      }
      return record;
    });
  }

  async fail(key, error, { tenantId = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantOrLocal(tenantId);
    return this.withPrincipal(persistencePrincipal, effectiveTenant, async client => {
      const selected = await client.query(
        'SELECT payload FROM idempotency WHERE key=$1 AND tenant_id=$2 LIMIT 1',
        [key, effectiveTenant]
      );
      if (!selected.rows.length) return null;
      const record = selected.rows[0].payload;
      assertTenant(tenantOrLocal(record.tenantId), effectiveTenant, 'Idempotency');
      if (record.status === 'failed') return record;
      if (record.status === 'completed') {
        const conflict = new Error('Completed idempotency record cannot be failed');
        conflict.code = 'IDEMPOTENCY_TERMINAL_CONFLICT'; conflict.status = 409; throw conflict;
      }
      if (record.status !== 'running') {
        const conflict = new Error('Idempotency record is not running');
        conflict.code = 'IDEMPOTENCY_TERMINAL_CONFLICT'; conflict.status = 409; throw conflict;
      }
      record.status = 'failed';
      record.error = {
        code: error?.code || 'EXECUTION_FAILED',
        message: error?.message || String(error || '')
      };
      record.completedAt = new Date().toISOString();
      const updated = await client.query(
        'UPDATE idempotency SET payload=$3,status=$4,updated_at=$5 WHERE key=$1 AND tenant_id=$2 AND status=$6',
        [key, effectiveTenant, record, record.status, record.completedAt, 'running']
      );
      if (updated.rowCount !== 1) {
        const conflict = new Error('Idempotency terminal transition lost a race');
        conflict.code = 'IDEMPOTENCY_TERMINAL_CONFLICT'; conflict.status = 409; throw conflict;
      }
      return record;
    });
  }

  async delete(key, { tenantId = 'local' } = {}) {
    const effectiveTenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      'DELETE FROM idempotency WHERE key=$1 AND tenant_id=$2',
      [key, effectiveTenant]
    );
    return result.rowCount === 1;
  }

  async count({ tenantId = 'local' } = {}) {
    const effectiveTenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      'SELECT COUNT(*)::int AS count FROM idempotency WHERE tenant_id=$1',
      [effectiveTenant]
    );
    return Number(result.rows[0].count);
  }
}

class PostgresCheckpointRepository {
  constructor(db) { this.db = db; }

  stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(item => this.stableStringify(item)).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + this.stableStringify(value[key])).join(',') + '}';
  }

  digest(snapshot) {
    return crypto.createHash('sha256').update(this.stableStringify(snapshot)).digest('hex');
  }

  async save(snapshot, { reason = 'step_completed', tenantId = null, persistencePrincipal = null } = {}) {
    if (!snapshot?.executionId) throw new TypeError('snapshot.executionId is required');
    const effectiveTenant = tenantOrLocal(snapshot.tenantId || snapshot.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Checkpoint');
    if (persistencePrincipal && snapshot.userId !== persistencePrincipal.ownerId) {
      throw Object.assign(new Error('Checkpoint owner does not match persistence principal'), { code: 'PERSISTENCE_PRINCIPAL_MISMATCH' });
    }
    const snapshotCopy = JSON.parse(JSON.stringify(snapshot));
    const digest = this.digest(snapshotCopy);
    const checkpointId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const persist = async client => {
      if (persistencePrincipal) {
        const ownerExecution = await client.query(
          "SELECT 1 FROM executions WHERE execution_id=$1 AND tenant_id=$2 AND payload->>'userId'=$3 LIMIT 1",
          [snapshot.executionId, effectiveTenant, persistencePrincipal.ownerId]
        );
        if (!ownerExecution.rows.length) {
          throw Object.assign(new Error('Checkpoint execution is not owned by the persistence principal'), {
            code: 'PERSISTENCE_PRINCIPAL_MISMATCH'
          });
        }
      }
      const collision = await client.query(
        'SELECT tenant_id FROM checkpoints WHERE execution_id=$1 AND tenant_id<>$2 LIMIT 1 FOR UPDATE',
        [snapshot.executionId,effectiveTenant]
      );
      if (collision.rows.length && collision.rows[0].tenant_id !== effectiveTenant) {
        const error = new Error('Checkpoint tenant collision');
        error.code = 'CHECKPOINT_TENANT_COLLISION';
        throw error;
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[snapshot.executionId]);
      const sequenceResult = await client.query(
        'SELECT COALESCE(MAX(sequence),0)+1 AS next_sequence FROM checkpoints WHERE execution_id=$1',
        [snapshot.executionId]
      );
      const sequence = Number(sequenceResult.rows[0].next_sequence);
      const result = await client.query(
        `INSERT INTO checkpoints(execution_id,tenant_id,sequence,checkpoint_id,reason,created_at,snapshot,snapshot_sha256)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING execution_id,tenant_id,sequence,checkpoint_id,reason,created_at,snapshot,snapshot_sha256`,
        [snapshot.executionId,effectiveTenant,sequence,checkpointId,reason,createdAt,snapshotCopy,digest]
      );
      return result.rows[0];
    };
    const persisted = persistencePrincipal
      ? await withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Checkpoint principal', persist)
      : await this.db.transaction(persist);
    return this.toModel(persisted);
  }

  toModel(row) {
    return {
      checkpointId: row.checkpoint_id, executionId: row.execution_id,
      sequence: Number(row.sequence), reason: row.reason,
      createdAt: row.created_at, snapshot: row.snapshot,
      snapshotSha256: row.snapshot_sha256
    };
  }

  async findLatest(executionId, { verify = true, tenantId = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    const result = await withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Checkpoint principal', client => {
      const values = [executionId];
      let where = 'execution_id=$1';
      if (effectiveTenant) {
        values.push(effectiveTenant);
        where += ' AND tenant_id=$' + values.length;
      }
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += ' AND snapshot->>\'userId\'=$' + values.length;
      }
      return client.query(
        'SELECT * FROM checkpoints WHERE ' + where + ' ORDER BY sequence DESC LIMIT 1',
        values
      );
    });
    if (!result.rows.length) return null;
    const row = result.rows[0];
    if (verify && row.snapshot_sha256 !== this.digest(row.snapshot)) {
      const error = new Error(`Checkpoint integrity verification failed: ${executionId}`);
      error.code = 'CHECKPOINT_INTEGRITY_FAILED';
      throw error;
    }
    return this.toModel(row);
  }

  async acquireResumeLease(executionId, { tenantId = null, leaseDurationMs = 30000, persistencePrincipal = null } = {}) {
    if (!executionId) throw new TypeError('executionId is required');
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new TypeError('leaseDurationMs must be a positive integer');
    }

    const effectiveTenant = tenantOrLocal(tenantId);
    const leaseId = crypto.randomUUID();
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Resume lease principal', async client => {
      const ownerClause = persistencePrincipal ? " AND c.snapshot->>'userId'=$5" : '';
      const insertValues = [executionId, effectiveTenant, leaseId, leaseDurationMs];
      if (persistencePrincipal) insertValues.push(persistencePrincipal.ownerId);
      const result = await client.query(
        `INSERT INTO execution_resume_leases(execution_id,tenant_id,lease_id,acquired_at,expires_at)
         SELECT c.execution_id,c.tenant_id,$3,NOW(),NOW()+($4::double precision * INTERVAL '1 millisecond')
         FROM checkpoints c
         WHERE c.execution_id=$1 AND c.tenant_id=$2${ownerClause}
         ORDER BY c.sequence DESC
         LIMIT 1
         ON CONFLICT (execution_id) DO UPDATE SET
           tenant_id=EXCLUDED.tenant_id,
           lease_id=EXCLUDED.lease_id,
           acquired_at=EXCLUDED.acquired_at,
           expires_at=EXCLUDED.expires_at
         WHERE execution_resume_leases.tenant_id=EXCLUDED.tenant_id
           AND execution_resume_leases.expires_at <= NOW()
         RETURNING lease_id,acquired_at,expires_at`,
        insertValues
      );

      if (result.rows.length) {
        const row = result.rows[0];
        return {
          leaseId: row.lease_id,
          acquiredAt: new Date(row.acquired_at).toISOString(),
          expiresAt: new Date(row.expires_at).toISOString(),
          expiresAtMs: new Date(row.expires_at).getTime()
        };
      }

      const checkpointValues = persistencePrincipal
        ? [executionId, effectiveTenant, persistencePrincipal.ownerId]
        : [executionId, effectiveTenant];
      const checkpointOwnerClause = persistencePrincipal ? " AND snapshot->>'userId'=$3" : '';
      const checkpoint = await client.query(
        'SELECT 1 FROM checkpoints WHERE execution_id=$1 AND tenant_id=$2' + checkpointOwnerClause + ' LIMIT 1',
        checkpointValues
      );
      if (!checkpoint.rows.length) return null;

      const existing = await client.query(
        'SELECT tenant_id,expires_at FROM execution_resume_leases WHERE execution_id=$1 LIMIT 1',
        [executionId]
      );
      if (existing.rows.length && existing.rows[0].tenant_id !== effectiveTenant) return null;

      const error = new Error('Execution resume lease is already held');
      error.code = 'CHECKPOINT_RESUME_LEASE_HELD';
      throw error;
    });
  }

  async renewResumeLease(executionId, leaseId, { tenantId = null, leaseDurationMs = 30000, persistencePrincipal = null } = {}) {
    if (!executionId || !leaseId) return null;
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new TypeError('leaseDurationMs must be a positive integer');
    }
    const effectiveTenant = tenantOrLocal(tenantId);
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Resume lease principal', async client => {
      const ownerClause = persistencePrincipal
        ? " AND EXISTS (SELECT 1 FROM checkpoints c WHERE c.execution_id=execution_resume_leases.execution_id AND c.tenant_id=execution_resume_leases.tenant_id AND c.snapshot->>'userId'=$5)"
        : '';
      const values = [executionId, effectiveTenant, leaseId, leaseDurationMs];
      if (persistencePrincipal) values.push(persistencePrincipal.ownerId);
      const result = await client.query(
        `UPDATE execution_resume_leases
         SET expires_at=NOW()+($4::double precision * INTERVAL '1 millisecond')
         WHERE execution_id=$1 AND tenant_id=$2 AND lease_id=$3 AND expires_at>NOW()${ownerClause}
         RETURNING lease_id,acquired_at,expires_at`,
        values
      );
      if (!result.rows.length) return null;
      const row = result.rows[0];
      return {
        leaseId: row.lease_id,
        acquiredAt: new Date(row.acquired_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
        expiresAtMs: new Date(row.expires_at).getTime()
      };
    });
  }

  async releaseResumeLease(executionId, leaseId, { tenantId = null, persistencePrincipal = null } = {}) {
    if (!executionId || !leaseId) return false;
    const effectiveTenant = tenantOrLocal(tenantId);
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Resume lease principal', async client => {
      const ownerClause = persistencePrincipal
        ? " AND EXISTS (SELECT 1 FROM checkpoints c WHERE c.execution_id=execution_resume_leases.execution_id AND c.tenant_id=execution_resume_leases.tenant_id AND c.snapshot->>'userId'=$4)"
        : '';
      const values = [executionId, effectiveTenant, leaseId];
      if (persistencePrincipal) values.push(persistencePrincipal.ownerId);
      const result = await client.query(
        'DELETE FROM execution_resume_leases WHERE execution_id=$1 AND tenant_id=$2 AND lease_id=$3' + ownerClause,
        values
      );
      return result.rowCount === 1;
    });
  }

  async delete(executionId, { tenantId = null } = {}) {
    const result = await this.db.query(
      tenantId ? 'DELETE FROM checkpoints WHERE execution_id=$1 AND tenant_id=$2' : 'DELETE FROM checkpoints WHERE execution_id=$1',
      tenantId ? [executionId, tenantId] : [executionId]
    );
    return result.rowCount === 1;
  }

  async count({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT COUNT(*)::int AS count FROM checkpoints WHERE tenant_id=$1', [tenantId])
      : await this.db.query('SELECT COUNT(*)::int AS count FROM checkpoints');
    return Number(result.rows[0].count);
  }
}

class PostgresWorkflowRepository {
  constructor(db, workerRegistry = null) { this.db = db; this.workerRegistry = workerRegistry; }

  async save(instance, tenantId = null, { workerPrincipal = null, persistencePrincipal = null } = {}) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenant = tenantOrLocal(item.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Workflow');
    if (workerPrincipal && persistencePrincipal) {
      throw Object.assign(new Error('Workflow writes must use either worker lease authority or owner authority, not both'), {
        code: 'WORKFLOW_AUTHORITY_AMBIGUOUS'
      });
    }
    const fencingToken = Number(item.metadata?.fencingToken || 0);
    if (fencingToken > 0) {
      const principal = assertWorkerPersistencePrincipal(workerPrincipal, { requireLease: true });
      if (principal.tenantId !== effectiveTenant || principal.workflowId !== item.workflowId ||
          principal.fencingToken !== fencingToken) {
        throw Object.assign(new Error('Worker principal does not match workflow write lease'), {
          code: 'WORKFLOW_FENCING_REJECTED'
        });
      }
      if (typeof this.db.transactionWithWorkerPrincipal !== 'function') {
        throw Object.assign(new Error('Worker-scoped PostgreSQL transactions are required'), {
          code: 'WORKER_PRINCIPAL_TRANSACTION_REQUIRED'
        });
      }
      return this.db.transactionWithWorkerPrincipal(principal, async client => {
        const worker = await client.query(
          `SELECT 1 FROM worker_nodes
           WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3
             AND status='READY' AND expires_at > NOW()
           FOR UPDATE`,
          [effectiveTenant, principal.workerId, principal.sessionId]
        );
        if (worker.rowCount !== 1) {
          throw Object.assign(new Error('Worker session is no longer active'), { code: 'WORKER_SESSION_LOST' });
        }
        const result = await client.query(
          `UPDATE workflows
           SET state=$3,updated_at=$4,payload=$5
           WHERE workflow_id=$1 AND tenant_id=$2
             AND EXISTS (
               SELECT 1 FROM workflow_leases
               WHERE workflow_id=$1 AND tenant_id=$2 AND lease_id=$6
                 AND worker_id=$7 AND worker_session_id=$8
                 AND fencing_token=$9 AND expires_at > NOW()
             )`,
          [item.workflowId, effectiveTenant, item.state, item.updatedAt || new Date().toISOString(),
            item, principal.leaseId, principal.workerId, principal.sessionId, principal.fencingToken]
        );
        if (result.rowCount !== 1) {
          throw Object.assign(new Error('Workflow write rejected by worker session and durable fencing'), {
            code: 'WORKFLOW_FENCING_REJECTED'
          });
        }
        return item;
      }, { requireLease: true });
    }
    if (persistencePrincipal) {
      const owner = assertPersistencePrincipal(persistencePrincipal);
      if (owner.tenantId !== effectiveTenant || item.userId !== owner.ownerId) {
        throw Object.assign(new Error('Workflow identity does not match the owner persistence principal'), {
          code: 'PERSISTENCE_PRINCIPAL_MISMATCH'
        });
      }
      return withPersistencePrincipal(this.db, owner, effectiveTenant, 'Workflow principal', async client => {
        const current = await client.query(
          "SELECT workflow_id FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 AND payload->>'userId'=$3 FOR UPDATE",
          [item.workflowId, effectiveTenant, owner.ownerId]
        );
        if (current.rowCount !== 1) {
          const inserted = await client.query(
            `INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload)
             VALUES($1,$2,$3,$4,$5) ON CONFLICT(workflow_id) DO NOTHING RETURNING workflow_id`,
            [item.workflowId, effectiveTenant, item.state, item.updatedAt || new Date().toISOString(), item]
          );
          if (inserted.rowCount === 1) return item;
          throw Object.assign(new Error('Workflow not found for the authenticated owner'), {
            code: 'WORKFLOW_NOT_FOUND'
          });
        }
        const activeDispatchClaim = await client.query(
          'SELECT 1 FROM workflow_dispatch_claims WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at > NOW() LIMIT 1',
          [item.workflowId, effectiveTenant]
        );
        if (activeDispatchClaim.rowCount > 0) {
          throw Object.assign(new Error('Owner workflow write rejected while a durable worker dispatch claim is active'), {
            code: 'WORKFLOW_DISPATCH_CLAIM_HELD'
          });
        }
        const activeLease = await client.query(
          'SELECT 1 FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at > NOW() LIMIT 1',
          [item.workflowId, effectiveTenant]
        );
        if (activeLease.rowCount > 0) {
          throw Object.assign(new Error('Owner workflow write rejected while a durable worker lease is active'), {
            code: 'WORKFLOW_LEASE_HELD'
          });
        }
        const updated = await client.query(
          "UPDATE workflows SET state=$4,updated_at=$5,payload=$6 WHERE workflow_id=$1 AND tenant_id=$2 AND payload->>'userId'=$3",
          [item.workflowId, effectiveTenant, owner.ownerId, item.state, item.updatedAt || new Date().toISOString(), item]
        );
        if (updated.rowCount !== 1) {
          throw Object.assign(new Error('Owner workflow write did not update its target row'), {
            code: 'WORKFLOW_NOT_FOUND'
          });
        }
        return item;
      });
    }
    if (workerPrincipal) {
      throw Object.assign(new Error('A lease-bound workflow write requires a persisted fencing token'), {
        code: 'WORKFLOW_FENCING_REJECTED'
      });
    }
    if (typeof this.db.transaction !== 'function') {
      throw Object.assign(new Error('Transactional workflow writes are required'), {
        code: 'WORKFLOW_TRANSACTION_REQUIRED'
      });
    }
    return this.db.transaction(async client => {
      let current = await client.query(
        'SELECT workflow_id FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 FOR UPDATE',
        [item.workflowId, effectiveTenant]
      );
      if (current.rowCount !== 1) {
        const inserted = await client.query(
          `INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT(workflow_id) DO NOTHING RETURNING workflow_id`,
          [item.workflowId, effectiveTenant, item.state, item.updatedAt || new Date().toISOString(), item]
        );
        if (inserted.rowCount === 1) return item;
        current = await client.query(
          'SELECT workflow_id FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 FOR UPDATE',
          [item.workflowId, effectiveTenant]
        );
        if (current.rowCount !== 1) {
          throw Object.assign(new Error('Workflow identity changed during persistence'), {
            code: 'WORKFLOW_CONCURRENT_WRITE'
          });
        }
      }
      const activeLease = await client.query(
        'SELECT 1 FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at > NOW() LIMIT 1',
        [item.workflowId, effectiveTenant]
      );
      if (activeLease.rowCount > 0) {
        throw Object.assign(new Error('Unleased workflow write rejected while a durable worker lease is active'), {
          code: 'WORKFLOW_LEASE_HELD'
        });
      }
      const updated = await client.query(
        'UPDATE workflows SET state=$3,updated_at=$4,payload=$5 WHERE workflow_id=$1 AND tenant_id=$2',
        [item.workflowId, effectiveTenant, item.state, item.updatedAt || new Date().toISOString(), item]
      );
      if (updated.rowCount !== 1) {
        throw Object.assign(new Error('Unleased workflow write did not update its target row'), {
          code: 'WORKFLOW_CONCURRENT_WRITE'
        });
      }
      return item;
    });
  }

  async claimQueued({tenantId='local',workerId,limit=100,claimTtlMs=5000,workerCapabilities=[],agingQuantumMs=30000,workerPrincipal=null}={}) {
    if (!workerId) throw new TypeError('workerId is required');
    const principal = assertWorkerPersistencePrincipal(workerPrincipal);
    const effectiveTenant = tenantOrLocal(tenantId);
    if (principal.tenantId !== effectiveTenant || principal.workerId !== workerId) {
      throw Object.assign(new Error('Worker principal does not match dispatch claim identity'), { code: 'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH' });
    }
    const safeLimit=Math.max(1,Math.min(1000,Number(limit)||100));
    const capabilities=Array.isArray(workerCapabilities)
      ? [...new Set(workerCapabilities.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))]
      : [];
    const principalCapabilities = new Set(principal.capabilities);
    if (capabilities.some(capability => !principalCapabilities.has(capability))) {
      throw Object.assign(new Error('Requested worker capabilities exceed principal authority'), { code: 'WORKER_CAPABILITY_MISMATCH' });
    }
    const safeAgingQuantumMs=Math.max(1000,Number(agingQuantumMs)||30000);
    const expiresAt=new Date(Date.now()+Math.max(1000,Number(claimTtlMs)||5000)).toISOString();
    if (typeof this.db.transactionWithWorkerPrincipal !== 'function') {
      throw Object.assign(new Error('Worker-scoped PostgreSQL transactions are required'), { code: 'WORKER_PRINCIPAL_TRANSACTION_REQUIRED' });
    }
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      if (this.workerRegistry) {
        const worker = await client.query(
          'SELECT worker_id,session_id,capabilities,status,expires_at FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2 FOR UPDATE',
          [effectiveTenant, workerId]
        );
        if (!worker.rows.length || worker.rows[0].session_id !== principal.sessionId ||
            new Date(worker.rows[0].expires_at).getTime() <= Date.now()) {
          const error = new Error('Worker session is not registered or its lease has expired');
          error.code = 'WORKER_SESSION_LOST';
          throw error;
        }
        if (worker.rows[0].status !== 'READY') {
          const error = new Error('Worker is not ready to claim work');
          error.code = 'WORKER_NOT_READY';
          throw error;
        }
        const registeredCapabilities = Array.isArray(worker.rows[0].capabilities)
          ? [...new Set(worker.rows[0].capabilities.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))]
          : [];
        const missing = capabilities.filter(capability => !registeredCapabilities.includes(capability));
        if (missing.length) {
          const error = new Error('Worker claim capabilities are not registered');
          error.code = 'WORKER_CAPABILITY_MISMATCH';
          error.missingCapabilities = missing;
          throw error;
        }
      }
      await client.query('DELETE FROM workflow_dispatch_claims WHERE tenant_id=$1 AND expires_at <= NOW()',[effectiveTenant]);
      const result=await client.query(
        `WITH candidates AS (
           SELECT w.workflow_id FROM workflows w
           WHERE w.tenant_id=$1 AND w.state IN ('QUEUED','WAITING','RECOVERING','RUNNING')
             AND COALESCE(w.payload->'metadata'->>'approvalBlocked','false') <> 'true'
             AND COALESCE(w.payload->'metadata'->'requiredCapabilities','[]'::jsonb) <@ $4::jsonb
             AND NOT EXISTS (SELECT 1 FROM workflow_dispatch_claims c WHERE c.tenant_id=w.tenant_id AND c.workflow_id=w.workflow_id AND c.expires_at > NOW())
             AND NOT EXISTS (SELECT 1 FROM workflow_leases l WHERE l.tenant_id=w.tenant_id AND l.workflow_id=w.workflow_id AND l.expires_at > NOW())
           ORDER BY (
             COALESCE((w.payload->>'priority')::int,0)
             + FLOOR(GREATEST(0,EXTRACT(EPOCH FROM (NOW()-w.updated_at))*1000) / $5)
           ) DESC, w.updated_at ASC
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         INSERT INTO workflow_dispatch_claims(tenant_id,workflow_id,worker_id,worker_session_id,claimed_at,expires_at)
         SELECT $1,workflow_id,$3,$7,NOW(),$6 FROM candidates
         ON CONFLICT (tenant_id,workflow_id) DO NOTHING RETURNING workflow_id`,
        [effectiveTenant,safeLimit,workerId,JSON.stringify(capabilities),safeAgingQuantumMs,expiresAt,principal.sessionId]
      );
      if(!result.rows.length) return [];
      const ids=result.rows.map(row=>row.workflow_id);
      const workflows=await client.query('SELECT payload FROM workflows WHERE tenant_id=$1 AND workflow_id=ANY($2::text[])',[effectiveTenant,ids]);
      const byId=new Map(workflows.rows.map(row=>[row.payload.workflowId,row.payload]));
      return ids.map(id=>byId.get(id)).filter(Boolean);
    });
  }

  async releaseDispatchClaim(workflowId,workerId,tenantId='local',{workerPrincipal=null}={}) {
    const principal = assertWorkerPersistencePrincipal(workerPrincipal);
    const effectiveTenant = tenantOrLocal(tenantId);
    if (principal.tenantId !== effectiveTenant || principal.workerId !== workerId) {
      throw Object.assign(new Error('Worker principal does not match dispatch release identity'), { code: 'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH' });
    }
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      const result=await client.query(
        'DELETE FROM workflow_dispatch_claims WHERE tenant_id=$1 AND workflow_id=$2 AND worker_id=$3 AND worker_session_id=$4',
        [effectiveTenant,workflowId,workerId,principal.sessionId]
      );
      return result.rowCount===1;
    });
  }

  async repair(instance, { tenantId = null, expectedRevision = 0, targetRevision } = {}) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenant = tenantOrLocal(item.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Workflow');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 ||
        !Number.isInteger(targetRevision) || targetRevision < expectedRevision) {
      throw Object.assign(new Error('Invalid workflow repair revision'), {
        code: 'WORKFLOW_REPAIR_REVISION_INVALID'
      });
    }
    return this.db.transaction(async client => {
      const current = await client.query(
        'SELECT payload FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 FOR UPDATE',
        [item.workflowId, effectiveTenant]
      );
      if (current.rowCount) {
        const revision = Number(current.rows[0].payload?.checkpoint?.revision || 0);
        const expectedLastSavedAt = item.checkpoint?.lastSavedAt || null;
        const currentLastSavedAt = current.rows[0].payload?.checkpoint?.lastSavedAt || null;
        if (revision !== expectedRevision || currentLastSavedAt !== expectedLastSavedAt) {
          throw Object.assign(new Error('Stale workflow checkpoint during repair'), {
            code: 'WORKFLOW_CHECKPOINT_CONFLICT'
          });
        }
        const activeClaim = await client.query(
          'SELECT 1 FROM workflow_dispatch_claims WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at > NOW() LIMIT 1',
          [item.workflowId, effectiveTenant]
        );
        if (activeClaim.rowCount > 0) {
          throw Object.assign(new Error('Workflow repair rejected while a worker dispatch claim is active'), {
            code: 'WORKFLOW_DISPATCH_CLAIM_HELD'
          });
        }
        const activeLease = await client.query(
          'SELECT 1 FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at > NOW() LIMIT 1',
          [item.workflowId, effectiveTenant]
        );
        if (activeLease.rowCount > 0) {
          throw Object.assign(new Error('Workflow repair rejected while a worker lease is active'), {
            code: 'WORKFLOW_LEASE_HELD'
          });
        }
      } else if (expectedRevision !== 0) {
        throw Object.assign(new Error('Workflow snapshot disappeared during repair'), {
          code: 'WORKFLOW_CHECKPOINT_CONFLICT'
        });
      }
      item.checkpoint = { revision: targetRevision, lastSavedAt: new Date().toISOString() };
      if (!current.rowCount) {
        const inserted = await client.query(
          'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workflow_id) DO NOTHING RETURNING workflow_id',
          [item.workflowId, effectiveTenant, item.state, item.updatedAt || item.checkpoint.lastSavedAt, item]
        );
        if (inserted.rowCount !== 1) {
          throw Object.assign(new Error('Workflow snapshot changed during repair'), {
            code: 'WORKFLOW_CHECKPOINT_CONFLICT'
          });
        }
      } else {
        const updated = await client.query(
          "UPDATE workflows SET state=$3,updated_at=$4,payload=$5 WHERE workflow_id=$1 AND tenant_id=$2 AND COALESCE((payload->'checkpoint'->>'revision')::int,0)=$6",
          [item.workflowId, effectiveTenant, item.state, item.updatedAt || item.checkpoint.lastSavedAt, item, expectedRevision]
        );
        if (updated.rowCount !== 1) {
          throw Object.assign(new Error('Workflow checkpoint changed during repair'), {
            code: 'WORKFLOW_CHECKPOINT_CONFLICT'
          });
        }
      }
      if (typeof instance?.setCheckpointRevision === 'function') {
        instance.setCheckpointRevision(targetRevision, item.checkpoint.lastSavedAt);
      }
      return item;
    });
  }

  async requestCancellation(workflowId, tenantId = null) {
    const effectiveTenant = tenantOrLocal(tenantId);
    return this.db.transaction(async client => {
      const result = await client.query(
        'SELECT payload,state FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 FOR UPDATE',
        [workflowId, effectiveTenant]
      );
      if (!result.rows.length) return false;
      const payload = { ...result.rows[0].payload, cancelRequested: true, updatedAt: new Date().toISOString() };
      const state = ['CREATED','QUEUED','WAITING','RECOVERING'].includes(result.rows[0].state) ? 'CANCELLED' : result.rows[0].state;
      payload.state = state;
      await client.query(
        'UPDATE workflows SET state=$3,updated_at=$4,payload=$5 WHERE workflow_id=$1 AND tenant_id=$2',
        [workflowId,effectiveTenant,state,payload.updatedAt,payload]
      );
      return payload;
    });
  }

  async findById(workflowId, tenantId = null, { persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : (persistencePrincipal?.tenantId || null);
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Workflow principal', async client => {
      const values = [workflowId];
      let where = 'workflow_id=$1';
      if (effectiveTenant) {
        values.push(effectiveTenant);
        where += ' AND tenant_id=' + '$' + values.length;
      }
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += " AND payload->>'userId'=" + '$' + values.length;
      }
      const result = await client.query('SELECT payload FROM workflows WHERE ' + where + ' LIMIT 1', values);
      return result.rows.length ? result.rows[0].payload : null;
    });
  }

  async findByApprovalExecutionId({ executionId, tenantId = null, persistencePrincipal = null } = {}) {
    if (!executionId) return null;
    const values = [String(executionId)];
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : (persistencePrincipal?.tenantId || null);
    let tenantClause = '';
    if (effectiveTenant) {
      values.push(effectiveTenant);
      tenantClause = ' AND tenant_id=' + '$' + values.length;
    }
    if (persistencePrincipal) {
      values.push(persistencePrincipal.ownerId);
      tenantClause += " AND payload->>'userId'=" + '$' + values.length;
    }
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Workflow principal', async client => {
      const result = await client.query(
        "SELECT payload FROM workflows WHERE payload->'metadata'->>'approvalBlocked'='true' " +
        "AND payload->'metadata'->>'approvalExecutionId'=$1" + tenantClause +
        ' ORDER BY updated_at DESC LIMIT 1',
        values
      );
      return result.rows.length ? result.rows[0].payload : null;
    });
  }

  async findAll({ tenantId = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : (persistencePrincipal?.tenantId || null);
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Workflow principal', async client => {
      const values = [];
      let where = '';
      if (effectiveTenant) {
        values.push(effectiveTenant);
        where = 'WHERE tenant_id=' + '$' + values.length;
      }
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += (where ? ' AND ' : 'WHERE ') + "payload->>'userId'=" + '$' + values.length;
      }
      const result = await client.query('SELECT payload FROM workflows ' + where + ' ORDER BY updated_at DESC', values);
      return result.rows.map(row => row.payload);
    });
  }

  async findPendingPublications({ tenantId = null, limit = 100 } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 100;
    const pendingArray = `CASE
      WHEN jsonb_typeof(payload->'metadata'->'pendingPublications')='array'
      THEN jsonb_array_length(payload->'metadata'->'pendingPublications')
      ELSE 0
    END > 0`;
    const result = tenantId
      ? await this.db.query(
        "SELECT payload FROM workflows WHERE tenant_id=$1 AND payload->'metadata'->>'approvalBlocked'='true' AND " +
          pendingArray + ' ORDER BY updated_at ASC LIMIT $2',
        [tenantId, boundedLimit]
      )
      : await this.db.query(
        "SELECT payload FROM workflows WHERE payload->'metadata'->>'approvalBlocked'='true' AND " +
          pendingArray + ' ORDER BY updated_at ASC LIMIT $1',
        [boundedLimit]
      );
    return result.rows.map(row => row.payload);
  }

  async acknowledgePendingPublications(workflowId, tenantId, eventIds = []) {
    const acknowledgedIds = validateAcknowledgement(workflowId, tenantId, eventIds);
    return this.db.transaction(async client => {
      const result = await client.query(
        'SELECT payload FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 FOR UPDATE',
        [workflowId, tenantId]
      );
      if (!result.rows.length) {
        throw Object.assign(new Error('Workflow not found for outbox acknowledgement'), {
          code: 'WORKFLOW_NOT_FOUND'
        });
      }
      const { updated, receipt } = prepareAcknowledgement(result.rows[0].payload, acknowledgedIds);
      if (!updated) return receipt;
      const written = await client.query(
        'UPDATE workflows SET payload=$3,updated_at=$4 WHERE workflow_id=$1 AND tenant_id=$2',
        [workflowId, tenantId, updated, receipt.lastSavedAt]
      );
      if (written.rowCount !== 1) {
        throw Object.assign(new Error('Workflow outbox acknowledgement did not update its locked row'), {
          code: 'WORKFLOW_OUTBOX_ACK_CONFLICT'
        });
      }
      return receipt;
    });
  }

  async delete(workflowId, tenantId = null) {
    const result = await this.db.query(
      tenantId ? 'DELETE FROM workflows WHERE workflow_id=$1 AND tenant_id=$2' : 'DELETE FROM workflows WHERE workflow_id=$1',
      tenantId ? [workflowId, tenantId] : [workflowId]
    );
    return result.rowCount === 1;
  }

  async count({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT COUNT(*)::int AS count FROM workflows WHERE tenant_id=$1', [tenantId])
      : await this.db.query('SELECT COUNT(*)::int AS count FROM workflows');
    return Number(result.rows[0].count);
  }
}

class PostgresWorkflowLeaseRepository {
  constructor(db) { this.db = db; }

  assertWorkerPrincipal(principal, tenantId, workerId = null, { requireLease = false } = {}) {
    const identity = assertWorkerPersistencePrincipal(principal, { requireLease });
    const tenant = tenantOrLocal(tenantId);
    if (identity.tenantId !== tenant || (workerId && identity.workerId !== workerId)) {
      throw Object.assign(new Error('Worker principal does not match workflow lease identity'), {
        code: 'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH'
      });
    }
    if (typeof this.db.transactionWithWorkerPrincipal !== 'function') {
      throw Object.assign(new Error('Worker-scoped PostgreSQL transactions are required'), {
        code: 'WORKER_PRINCIPAL_TRANSACTION_REQUIRED'
      });
    }
    return identity;
  }

  async assertRegisteredWorkerSession(client, principal) {
    const result = await client.query(
      `SELECT 1 FROM worker_nodes
       WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3
         AND status='READY' AND expires_at > NOW()
       FOR UPDATE`,
      [principal.tenantId, principal.workerId, principal.sessionId]
    );
    if (result.rowCount !== 1) {
      throw Object.assign(new Error('Worker session is no longer active'), { code: 'WORKER_SESSION_LOST' });
    }
    return true;
  }

  async tryAcquire(lease, tenantId = null, { workerPrincipal = null } = {}) {
    const effectiveTenant = tenantOrLocal(lease.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Lease');
    const principal = this.assertWorkerPrincipal(workerPrincipal, effectiveTenant, lease.workerId);
    const acquiredAt = new Date(lease.acquiredAt).toISOString();
    const expiresAt = new Date(lease.expiresAt).toISOString();

    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      await this.assertRegisteredWorkerSession(client, principal);
      const workflow = await client.query(
        'SELECT state,payload FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 FOR UPDATE',
        [lease.workflowId, effectiveTenant]
      );
      if (!workflow.rows.length) {
        throw Object.assign(new Error('Workflow is not durably registered'), { code: 'WORKFLOW_NOT_FOUND' });
      }
      const workflowState = workflow.rows[0].state;
      const workflowPayload = workflow.rows[0].payload || {};
      if (workflowPayload.cancelRequested || workflowState === 'CANCELLED') {
        throw Object.assign(new Error('Workflow cancellation was requested'), { code: 'WORKFLOW_CANCELLATION_REQUESTED' });
      }
      if (['COMPLETED','FAILED'].includes(workflowState)) {
        throw Object.assign(new Error('Workflow is terminal'), { code: 'WORKFLOW_TERMINAL' });
      }
      await client.query(
        'DELETE FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at <= $3',
        [lease.workflowId, effectiveTenant, acquiredAt]
      );
      const result = await client.query(
        `INSERT INTO workflow_leases(workflow_id,tenant_id,lease_id,worker_id,worker_session_id,acquired_at,expires_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(workflow_id) DO NOTHING
         RETURNING fencing_token`,
        [lease.workflowId,effectiveTenant,lease.leaseId,lease.workerId,principal.sessionId,acquiredAt,expiresAt,lease]
      );
      if (result.rowCount !== 1) return null;
      return { ...lease, workerSessionId: principal.sessionId, fencingToken: Number(result.rows[0].fencing_token) };
    });
  }

  async save(lease, tenantId = null, { workerPrincipal = null } = {}) {
    const effectiveTenant = tenantOrLocal(lease.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Lease');
    const principal = this.assertWorkerPrincipal(workerPrincipal, effectiveTenant, lease.workerId, { requireLease: true });
    if (principal.workflowId !== lease.workflowId || principal.leaseId !== lease.leaseId ||
        Number(principal.fencingToken) !== Number(lease.fencingToken)) {
      throw Object.assign(new Error('Lease principal does not match the lease payload'), { code: 'WORKFLOW_FENCING_REJECTED' });
    }
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      await this.assertRegisteredWorkerSession(client, principal);
      const result = await client.query(
        `UPDATE workflow_leases SET expires_at=$1,payload=$2
         WHERE workflow_id=$3 AND tenant_id=$4 AND lease_id=$5 AND worker_id=$6
           AND worker_session_id=$7 AND fencing_token=$8 AND expires_at > NOW()`,
        [new Date(lease.expiresAt).toISOString(),lease,lease.workflowId,effectiveTenant,lease.leaseId,principal.workerId,principal.sessionId,principal.fencingToken]
      );
      if (result.rowCount !== 1) {
        throw Object.assign(new Error('Workflow lease is no longer owned by this worker session'), { code: 'WORKFLOW_LEASE_NOT_OWNER' });
      }
      return { ...lease };
    });
  }

  async renewIfOwned(workflowId, leaseId, expiresAt, now = Date.now(), tenantId = null, { workerPrincipal = null } = {}) {
    const principal = this.assertWorkerPrincipal(workerPrincipal, tenantId, null, { requireLease: true });
    if (principal.workflowId !== workflowId || principal.leaseId !== leaseId) {
      throw Object.assign(new Error('Lease principal does not match renewal request'), { code: 'WORKFLOW_FENCING_REJECTED' });
    }
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      await this.assertRegisteredWorkerSession(client, principal);
      const result = await client.query(
        `UPDATE workflow_leases SET expires_at=$1::timestamptz,
           payload=jsonb_set(payload,'{expiresAt}',to_jsonb($1::timestamptz::text))
         WHERE workflow_id=$2 AND tenant_id=$3 AND lease_id=$4 AND worker_id=$5
           AND worker_session_id=$6 AND fencing_token=$7 AND expires_at > $8`,
        [new Date(expiresAt).toISOString(),workflowId,principal.tenantId,leaseId,principal.workerId,principal.sessionId,principal.fencingToken,new Date(now).toISOString()]
      );
      return result.rowCount === 1;
    });
  }

  async assertCurrent(workflowId, leaseId, fencingToken, now = Date.now(), tenantId = null, { workerPrincipal = null } = {}) {
    const principal = this.assertWorkerPrincipal(workerPrincipal, tenantId, null, { requireLease: true });
    if (principal.workflowId !== workflowId || principal.leaseId !== leaseId ||
        Number(principal.fencingToken) !== Number(fencingToken)) return false;
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      await this.assertRegisteredWorkerSession(client, principal);
      const result = await client.query(
        `SELECT 1 FROM workflow_leases
         WHERE workflow_id=$1 AND tenant_id=$2 AND lease_id=$3 AND worker_id=$4
           AND worker_session_id=$5 AND fencing_token=$6 AND expires_at > $7 LIMIT 1`,
        [workflowId,principal.tenantId,leaseId,principal.workerId,principal.sessionId,principal.fencingToken,new Date(now).toISOString()]
      );
      return result.rowCount === 1;
    });
  }

  async findByWorkflowId(workflowId, tenantId = null) {
    const result = await this.db.query(
      tenantId ? 'SELECT payload,expires_at,acquired_at,worker_session_id,fencing_token FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 LIMIT 1' : 'SELECT payload,expires_at,acquired_at,worker_session_id,fencing_token FROM workflow_leases WHERE workflow_id=$1 LIMIT 1',
      tenantId ? [workflowId, tenantId] : [workflowId]
    );
    return result.rows.length ? { ...result.rows[0].payload, workerSessionId: result.rows[0].worker_session_id, fencingToken: Number(result.rows[0].fencing_token), expiresAt: new Date(result.rows[0].expires_at).getTime(), acquiredAt: new Date(result.rows[0].acquired_at).getTime() } : null;
  }

  async findAll({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT payload,expires_at,acquired_at,worker_session_id,fencing_token FROM workflow_leases WHERE tenant_id=$1 ORDER BY acquired_at ASC', [tenantId])
      : await this.db.query('SELECT payload,expires_at,acquired_at,worker_session_id,fencing_token FROM workflow_leases ORDER BY acquired_at ASC');
    return result.rows.map(row => ({ ...row.payload, workerSessionId: row.worker_session_id, fencingToken: Number(row.fencing_token), expiresAt: new Date(row.expires_at).getTime(), acquiredAt: new Date(row.acquired_at).getTime() }));
  }

  async delete(workflowId, leaseId, tenantId = null, { workerPrincipal = null } = {}) {
    const principal = this.assertWorkerPrincipal(workerPrincipal, tenantId, null, { requireLease: true });
    if (principal.workflowId !== workflowId || principal.leaseId !== leaseId) {
      throw Object.assign(new Error('Lease principal does not match release request'), { code: 'WORKFLOW_FENCING_REJECTED' });
    }
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      await this.assertRegisteredWorkerSession(client, principal);
      const result = await client.query(
        `DELETE FROM workflow_leases WHERE workflow_id=$1 AND lease_id=$2 AND tenant_id=$3
         AND worker_id=$4 AND worker_session_id=$5 AND fencing_token=$6`,
        [workflowId,leaseId,principal.tenantId,principal.workerId,principal.sessionId,principal.fencingToken]
      );
      return result.rowCount === 1;
    });
  }

  async deleteExpired(workflowId, leaseId, now = Date.now(), tenantId = null) {
    const result = await this.db.query(
      tenantId
        ? 'DELETE FROM workflow_leases WHERE workflow_id=$1 AND lease_id=$2 AND tenant_id=$3 AND expires_at <= $4'
        : 'DELETE FROM workflow_leases WHERE workflow_id=$1 AND lease_id=$2 AND expires_at <= $3',
      tenantId
        ? [workflowId, leaseId, tenantId, new Date(now).toISOString()]
        : [workflowId, leaseId, new Date(now).toISOString()]
    );
    return result.rowCount === 1;
  }

  async count({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT COUNT(*)::int AS count FROM workflow_leases WHERE tenant_id=$1', [tenantId])
      : await this.db.query('SELECT COUNT(*)::int AS count FROM workflow_leases');
    return Number(result.rows[0].count);
  }
}

class PostgresApprovalRepository {
  constructor(db) { this.db = db; }

  mapRow(row) {
    return {
      approvalId: row.approval_id, executionId: row.execution_id, step: Number(row.step),
      planRevision: Number(row.plan_revision), tool: row.tool, capability: row.capability,
      scope: row.scope, issuedAt: row.issued_at, expiresAt: row.expires_at,
      used: Boolean(row.used), usedAt: row.used_at || undefined,
      metadata: row.metadata, decision: row.metadata?.decision || null, tenantId: row.tenant_id
    };
  }

  async findByExecution({ executionId, step = null, tool = null, planRevision = null, tenantId = null, persistencePrincipal = null } = {}) {
    if (!executionId) return [];
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Approval principal', async client => {
      const values = [String(executionId)];
      const clauses = ['execution_id=$1'];
      if (effectiveTenant) { values.push(effectiveTenant); clauses.push(`tenant_id=$${values.length}`); }
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        clauses.push(`e.payload->>'userId'=$${values.length}`);
      }
      if (step !== null) { values.push(Number(step)); clauses.push(`step=$${values.length}`); }
      if (tool !== null) { values.push(tool); clauses.push(`tool=$${values.length}`); }
      if (planRevision !== null) { values.push(Number(planRevision)); clauses.push(`plan_revision=$${values.length}`); }
      const query = persistencePrincipal
        ? `SELECT a.* FROM approvals a JOIN executions e ON e.execution_id=a.execution_id AND e.tenant_id=a.tenant_id WHERE ${clauses.map(clause => clause.replace(/^(execution_id|tenant_id|step|tool|plan_revision)=/, 'a.$1=')).join(' AND ')} ORDER BY a.issued_at DESC`
        : `SELECT * FROM approvals WHERE ${clauses.join(' AND ')} ORDER BY issued_at DESC`;
      const result = await client.query(query, values);
      return result.rows.map(row => this.mapRow(row));
    });
  }
  async findPending({ tenantId = null, limit = 100, now = Date.now(), persistencePrincipal = null } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    const nowIso = new Date(now).toISOString();
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Approval principal', async client => {
      if (!persistencePrincipal) {
        const result = effectiveTenant
          ? await client.query(`SELECT * FROM approvals WHERE tenant_id=$1 AND used=FALSE AND expires_at>$2 AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'decision') ORDER BY issued_at ASC, approval_id ASC LIMIT $3`, [effectiveTenant, nowIso, boundedLimit])
          : await client.query(`SELECT * FROM approvals WHERE used=FALSE AND expires_at>$1 AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'decision') ORDER BY issued_at ASC, approval_id ASC LIMIT $2`, [nowIso, boundedLimit]);
        return result.rows.map(row => this.mapRow(row));
      }
      const values = [nowIso];
      const clauses = ['a.used=FALSE', 'a.expires_at>$1', "NOT (COALESCE(a.metadata, '{}'::jsonb) ? 'decision')"];
      if (effectiveTenant) { values.push(effectiveTenant); clauses.push(`a.tenant_id=$${values.length}`); }
      values.push(persistencePrincipal.ownerId);
      clauses.push(`e.payload->>'userId'=$${values.length}`);
      values.push(boundedLimit);
      const result = await client.query(
        `SELECT a.* FROM approvals a JOIN executions e ON e.execution_id=a.execution_id AND e.tenant_id=a.tenant_id WHERE ${clauses.join(' AND ')} ORDER BY a.issued_at ASC, a.approval_id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(row => this.mapRow(row));
    });
  }
  async save(approval, { tenantId = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantOrLocal(approval.tenantId || approval.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Approval');
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Approval principal', async client => {
      if (persistencePrincipal) {
        const owner = await client.query(
          "SELECT 1 FROM executions WHERE execution_id=$1 AND tenant_id=$2 AND payload->>'userId'=$3 LIMIT 1",
          [approval.executionId, effectiveTenant, persistencePrincipal.ownerId]
        );
        if (!owner.rows.length) throw Object.assign(new Error('Approval execution is not owned by the persistence principal'), { code: 'PERSISTENCE_PRINCIPAL_MISMATCH' });
      }
      await client.query(
        `INSERT INTO approvals(approval_id,tenant_id,execution_id,step,plan_revision,tool,capability,scope,issued_at,expires_at,used,used_at,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [approval.approvalId,effectiveTenant,approval.executionId,approval.step,approval.planRevision,approval.tool,approval.capability,approval.scope,approval.issuedAt,approval.expiresAt,Boolean(approval.used),approval.usedAt || null,{...(approval.metadata || {}),tenantId:effectiveTenant}]
      );
      return { ...approval, tenantId: effectiveTenant };
    });
  }
  async findById(approvalId, { tenantId = null, persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Approval principal', async client => {
      const values = [approvalId];
      let where = 'a.approval_id=$1';
      if (effectiveTenant) { values.push(effectiveTenant); where += ` AND a.tenant_id=$${values.length}`; }
      let join = '';
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += ` AND e.payload->>'userId'=$${values.length}`;
        join = ' JOIN executions e ON e.execution_id=a.execution_id AND e.tenant_id=a.tenant_id';
      }
      const result = await client.query(`SELECT a.* FROM approvals a${join} WHERE ${where} LIMIT 1`, values);
      return result.rows.length ? this.mapRow(result.rows[0]) : null;
    });
  }
  async consume(approvalId, usedAt, tenantId = null, { persistencePrincipal = null } = {}) {
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Approval principal', async client => {
      const values = [usedAt, approvalId];
      let where = 'approval_id=$2 AND used=FALSE AND expires_at>$1';
      if (effectiveTenant) { values.push(effectiveTenant); where += ` AND tenant_id=$${values.length}`; }
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += ` AND EXISTS (SELECT 1 FROM executions e WHERE e.execution_id=approvals.execution_id AND e.tenant_id=approvals.tenant_id AND e.payload->>'userId'=$${values.length})`;
      }
      const result = await client.query(`UPDATE approvals SET used=TRUE,used_at=$1 WHERE ${where}`, values);
      return result.rowCount === 1;
    });
  }
  async recordDecision(approvalId, decision, tenantId = null, now = () => Date.now(), persistencePrincipal = null) {
    if (typeof approvalId !== 'string' || !approvalId.trim()) throw Object.assign(new TypeError('approvalId is required'), { code: 'APPROVAL_ID_REQUIRED' });
    if (!decision || !['approved', 'rejected'].includes(decision.status) || typeof decision.actorId !== 'string' || !decision.actorId.trim() || typeof decision.decidedAt !== 'string' || !Number.isFinite(Date.parse(decision.decidedAt))) throw Object.assign(new TypeError('Invalid approval decision'), { code: 'APPROVAL_DECISION_INVALID' });
    const nowMs = typeof now === 'function' ? now() : now;
    if (!Number.isFinite(nowMs)) throw Object.assign(new Error('Invalid decision clock'), { code: 'APPROVAL_EXPIRED' });
    const nowIso = new Date(nowMs).toISOString();
    const effectiveTenant = tenantId ? tenantOrLocal(tenantId) : null;
    return withPersistencePrincipal(this.db, persistencePrincipal, effectiveTenant, 'Approval principal', async client => {
      const selectValues = [approvalId];
      let selectWhere = 'a.approval_id=$1';
      if (effectiveTenant) { selectValues.push(effectiveTenant); selectWhere += ` AND a.tenant_id=$${selectValues.length}`; }
      let join = '';
      if (persistencePrincipal) {
        selectValues.push(persistencePrincipal.ownerId);
        selectWhere += ` AND e.payload->>'userId'=$${selectValues.length}`;
        join = ' JOIN executions e ON e.execution_id=a.execution_id AND e.tenant_id=a.tenant_id';
      }
      const selected = await client.query(`SELECT a.* FROM approvals a${join} WHERE ${selectWhere} LIMIT 1`, selectValues);
      if (!selected.rows.length) throw Object.assign(new Error('Approval not found'), { code: 'APPROVAL_NOT_FOUND' });
      const current = this.mapRow(selected.rows[0]);
      if (current.decision) {
        if (current.decision.status === decision.status && current.decision.actorId === decision.actorId) return current;
        throw Object.assign(new Error('Approval decision is immutable'), { code: 'APPROVAL_DECISION_CONFLICT' });
      }
      if (current.used) throw Object.assign(new Error('Approval already consumed'), { code: 'APPROVAL_ALREADY_USED' });
      const expiry = Date.parse(current.expiresAt);
      if (!Number.isFinite(expiry) || nowMs >= expiry) throw Object.assign(new Error('Approval expired'), { code: 'APPROVAL_EXPIRED' });
      const values = [JSON.stringify(decision), approvalId, nowIso];
      let where = "approval_id=$2 AND used=FALSE AND expires_at>$3 AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'decision')";
      if (effectiveTenant) { values.push(effectiveTenant); where += ` AND tenant_id=$${values.length}`; }
      if (persistencePrincipal) {
        values.push(persistencePrincipal.ownerId);
        where += ` AND EXISTS (SELECT 1 FROM executions e WHERE e.execution_id=approvals.execution_id AND e.tenant_id=approvals.tenant_id AND e.payload->>'userId'=$${values.length})`;
      }
      const updated = await client.query(`UPDATE approvals SET metadata=COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('decision', $1::jsonb) WHERE ${where} RETURNING *`, values);
      if (updated.rowCount === 1) return this.mapRow(updated.rows[0]);
      const latest = await client.query(`SELECT a.* FROM approvals a${join} WHERE ${selectWhere} LIMIT 1`, selectValues);
      const record = latest.rows[0] ? this.mapRow(latest.rows[0]) : null;
      if (record?.decision?.status === decision.status && record?.decision?.actorId === decision.actorId) return record;
      if (record?.decision) throw Object.assign(new Error('Approval decision is immutable'), { code: 'APPROVAL_DECISION_CONFLICT' });
      if (record?.used) throw Object.assign(new Error('Approval already consumed'), { code: 'APPROVAL_ALREADY_USED' });
      throw Object.assign(new Error('Approval expired or could not be recorded'), { code: 'APPROVAL_EXPIRED' });
    });
  }
  async count({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT COUNT(*)::int AS count FROM approvals WHERE tenant_id=$1', [tenantId])
      : await this.db.query('SELECT COUNT(*)::int AS count FROM approvals');
    return Number(result.rows[0].count);
  }
}

class PostgresPersistence {
  constructor({ pool, schema } = {}) {
    this.isAsync = true;
    this.db = pool instanceof PostgresDatabase ? pool : new PostgresDatabase({ pool, schema });
    this.executions = new PostgresExecutionRepository(this.db);
    this.events = new PostgresEventRepository(this.db);
    this.idempotency = new PostgresIdempotencyRepository(this.db);
    this.checkpoints = new PostgresCheckpointRepository(this.db);
    this.workers = new PostgresWorkerRegistryRepository(this.db);
    this.workflows = new PostgresWorkflowRepository(this.db, this.workers);
    this.workflowLeases = new PostgresWorkflowLeaseRepository(this.db);
    this.approvals = new PostgresApprovalRepository(this.db);
    this.tenantQuotas = new PostgresTenantQuotaRepository(this.db);
    this.ownerChat = new PostgresOwnerChatConversationRepository(this.db);
    this.ownerProfile = new PostgresOwnerWorkProfileRepository(this.db);
    this.workers = new PostgresWorkerRegistryRepository(this.db);
  }

  initialize() {
    return this.db.initialize();
  }

  health() {
    return {
      adapter: 'postgres',
      ready: true,
      repositories: {
        executions: true,
        events: true,
        idempotency: true,
        checkpoints: true,
        workflows: true,
        workflowLeases: true,
        approvals: true,
        tenantQuotas: true,
        ownerChat: true,
        ownerProfile: true,
        workers: true
      }
    };
  }
}

module.exports = {
  PostgresPersistence,
  PostgresExecutionRepository,
  PostgresEventRepository,
  PostgresIdempotencyRepository,
  PostgresCheckpointRepository,
  PostgresWorkflowRepository,
  PostgresWorkflowLeaseRepository,
  PostgresApprovalRepository,
  PostgresWorkerRegistryRepository,
  PostgresOwnerChatConversationRepository,
  PostgresOwnerWorkProfileRepository
};
