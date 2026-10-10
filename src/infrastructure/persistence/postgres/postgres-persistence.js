const crypto = require('crypto');
const { PostgresDatabase } = require('./postgres-database');
const PostgresTenantQuotaRepository = require('./postgres-tenant-quota-repository');
const PostgresWorkerRegistryRepository = require('./postgres-worker-registry-repository');

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

class PostgresExecutionRepository {
  constructor(db) { this.db = db; }

  async findById(executionId, { tenantId = null } = {}) {
    const values = tenantId ? [executionId, tenantId] : [executionId];
    const where = tenantId ? 'AND tenant_id=$2' : '';
    const result = await this.db.query(
      `SELECT payload FROM executions WHERE execution_id=$1 ${where} LIMIT 1`,
      values
    );
    return result.rows.length ? result.rows[0].payload : null;
  }

  async findAll({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT payload FROM executions WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId])
      : await this.db.query('SELECT payload FROM executions ORDER BY updated_at DESC');
    return result.rows.map(row => row.payload);
  }

  async findPage({ tenantId = null, limit = 50, offset = 0 } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
    const boundedOffset = Number.isInteger(offset) ? Math.max(0, Math.min(offset, 10000)) : 0;
    const [countResult, pageResult] = tenantId
      ? await Promise.all([
          this.db.query('SELECT COUNT(*)::int AS total FROM executions WHERE tenant_id=$1', [tenantId]),
          this.db.query('SELECT payload FROM executions WHERE tenant_id=$1 ORDER BY updated_at DESC, execution_id DESC LIMIT $2 OFFSET $3', [tenantId, boundedLimit, boundedOffset])
        ])
      : await Promise.all([
          this.db.query('SELECT COUNT(*)::int AS total FROM executions'),
          this.db.query('SELECT payload FROM executions ORDER BY updated_at DESC, execution_id DESC LIMIT $1 OFFSET $2', [boundedLimit, boundedOffset])
        ]);
    return { total: Number(countResult.rows[0]?.total || 0), limit: boundedLimit, offset: boundedOffset, executions: pageResult.rows.map(row => row.payload) };
  }


  async findByGoalId(goalId, { tenantId = null } = {}) {
    const result = await this.db.query(tenantId ? 'SELECT payload FROM executions WHERE tenant_id=$1 AND payload->>\'goalId\'=$2 ORDER BY updated_at DESC' : 'SELECT payload FROM executions WHERE payload->>\'goalId\'=$1 ORDER BY updated_at DESC', tenantId ? [tenantId,goalId] : [goalId]); return result.rows.map(row => row.payload);
  }

  async insert(execution, { tenantId = null } = {}) {
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
    await this.db.query(
      'INSERT INTO executions(execution_id,tenant_id,payload,updated_at) VALUES($1,$2,$3,$4)',
      [normalized.executionId, effectiveTenant, normalized, normalized.updatedAt]
    );
    return normalized;
  }

  async update(executionId, patch, { tenantId = null } = {}) {
    const current = await this.findById(executionId, { tenantId });
    if (!current) return null;
    const effectiveTenant = tenantOrLocal(current.tenantId || current.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Execution');
    const updated = {
      ...current, ...patch,
      ...(current.cancellationRequested ? { cancellationRequested: true, cancellationReason: current.cancellationReason || patch.cancellationReason || null } : {}),
      id: current.id,
      executionId: current.executionId,
      tenantId: effectiveTenant,
      updatedAt: new Date().toISOString()
    };
    // Compare-and-set the terminal outcome in PostgreSQL itself. The
    // cancellation flag is read from the row being updated, not from the
    // earlier snapshot, so a concurrent cancellation cannot be overwritten
    // by a stale completion write.
    const result = await this.db.query(
      `UPDATE executions
       SET payload=$3, updated_at=$4
       WHERE execution_id=$1
         AND tenant_id=$2
         AND NOT (
           COALESCE(payload->>'cancellationRequested', 'false') = 'true'
           AND $5::text IN ('completed', 'failed')
         )
       RETURNING payload`,
      [executionId, effectiveTenant, updated, updated.updatedAt, patch.status || '']
    );

    if (result.rows.length) return result.rows[0].payload;
    // A concurrent cancellation won the race; return the authoritative row.
    return this.findById(executionId, { tenantId: effectiveTenant });
  }

  async requestCancellation(executionId, reason = 'Execution cancellation requested', { tenantId = null } = {}) {
    if (!executionId) throw new TypeError('executionId is required');

    const effectiveTenant = tenantOrLocal(tenantId);
    const updatedAt = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE executions
       SET payload = jsonb_set(
         jsonb_set(payload, '{cancellationRequested}', 'true'::jsonb, true),
         '{cancellationReason}', to_jsonb($3::text), true
       ),
       updated_at = $4
       WHERE execution_id=$1
         AND tenant_id=$2
         AND COALESCE(payload->>'status','created') NOT IN ('completed','failed','cancelled')
       RETURNING payload`,
      [executionId, effectiveTenant, String(reason || 'Execution cancellation requested'), updatedAt]
    );

    if (result.rows.length) return result.rows[0].payload;
    return this.findById(executionId, { tenantId: effectiveTenant });
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
      timestamp: event.timestamp || new Date().toISOString(),
      data: { ...(event.data || {}), tenantId: effectiveTenant }
    };
  }

  async append(event, { tenantId = null } = {}) {
    const normalized = this.normalize(event, tenantId);
    await this.db.query(
      `INSERT INTO events(event_id,tenant_id,execution_id,goal_id,type,timestamp,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(event_id) DO NOTHING`,
      [normalized.id, normalized.data.tenantId, normalized.executionId, normalized.goalId, normalized.type, normalized.timestamp, normalized]
    );
    return normalized;
  }

  async appendMany(events, { tenantId = null } = {}) {
    const inserted = [];
    await this.db.transaction(async client => {
      for (const event of events || []) {
        const normalized = this.normalize(event, tenantId);
        const result = await client.query(
          `INSERT INTO events(event_id,tenant_id,execution_id,goal_id,type,timestamp,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(event_id) DO NOTHING`,
          [normalized.id, normalized.data.tenantId, normalized.executionId, normalized.goalId, normalized.type, normalized.timestamp, normalized]
        );
        if (result.rowCount === 1) inserted.push(normalized);
      }
    });
    return inserted;
  }

  async findAll({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT payload FROM events WHERE tenant_id=$1 ORDER BY timestamp ASC', [tenantId])
      : await this.db.query('SELECT payload FROM events ORDER BY timestamp ASC');
    return result.rows.map(row => row.payload);
  }

  async findByExecutionId(id, { tenantId = null, limit = null } = {}) {
    if (Number.isInteger(limit) && limit > 0) {
      const boundedLimit = Math.min(limit, 200);
      const result = tenantId
        ? await this.db.query('SELECT payload FROM (SELECT payload,timestamp,event_id FROM events WHERE tenant_id=$1 AND execution_id=$2 ORDER BY timestamp DESC,event_id DESC LIMIT $3) recent ORDER BY timestamp ASC,event_id ASC', [tenantId, id, boundedLimit])
        : await this.db.query('SELECT payload FROM (SELECT payload,timestamp,event_id FROM events WHERE execution_id=$1 ORDER BY timestamp DESC,event_id DESC LIMIT $2) recent ORDER BY timestamp ASC,event_id ASC', [id, boundedLimit]);
      return result.rows.map(row => row.payload);
    }
    const result = await this.db.query(tenantId ? 'SELECT payload FROM events WHERE tenant_id=$1 AND execution_id=$2 ORDER BY timestamp ASC,event_id ASC' : 'SELECT payload FROM events WHERE execution_id=$1 ORDER BY timestamp ASC,event_id ASC', tenantId ? [tenantId,id] : [id]);
    return result.rows.map(row => row.payload);
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

  async findByKey(key, { tenantId = 'local' } = {}) {
    const effectiveTenant = tenantOrLocal(tenantId);
    const result = await this.db.query('SELECT payload FROM idempotency WHERE key=$1 AND tenant_id=$2 LIMIT 1',[key,effectiveTenant]);
    if (!result.rows.length) return null;
    const record = result.rows[0].payload;
    assertTenant(tenantOrLocal(record.tenantId), effectiveTenant, 'Idempotency');
    return record;
  }

  async find(args) {
    return this.findByKey(this.buildKey(args), { tenantId: args?.tenantId || 'local' });
  }

  async begin(args) {
    const key = this.buildKey(args);
    const tenantId = args?.tenantId || 'local';
    const record = {
      id: crypto.randomUUID(), key,
      executionId: args.executionId, step: args.step, tool: args.tool,
      planRevision: args.planRevision || 1, operationId: args.operationId || null,
      tenantId, status: 'running', result: null, error: null,
      startedAt: new Date().toISOString(), completedAt: null
    };
    const result = await this.db.query(
      `INSERT INTO idempotency(key,tenant_id,payload,status,updated_at)
       VALUES($1,$2,$3,'running',$4)
       ON CONFLICT(tenant_id,key) DO NOTHING`,
      [key, tenantId, record, record.startedAt]
    );
    if (result.rowCount === 1) return { created: true, key, record };
    const existing = await this.findByKey(key, { tenantId });
    return { created: false, key, record: existing };
  }

  async complete(key, result, { tenantId = null } = {}) {
    const record = await this.findByKey(key, { tenantId });
    if (!record) return null;
    if (record.status === 'completed') {
      if (JSON.stringify(record.result) !== JSON.stringify(result ?? null)) { const error = new Error('Idempotency record is already completed with a different result'); error.code='IDEMPOTENCY_TERMINAL_CONFLICT'; error.status=409; throw error; }
      return record;
    }
    if (record.status !== 'running') { const error=new Error('Idempotency record is not running'); error.code='IDEMPOTENCY_TERMINAL_CONFLICT'; error.status=409; throw error; }
    record.status='completed'; record.result=result ?? null; record.completedAt=new Date().toISOString();
    const updated=await this.db.query('UPDATE idempotency SET payload=$3,status=$4,updated_at=$5 WHERE key=$1 AND tenant_id=$2 AND status=$6',
      [key, tenantId || record.tenantId, record, record.status, record.completedAt, 'running']);
    if (updated.rowCount !== 1) { const error=new Error('Idempotency terminal transition lost a race'); error.code='IDEMPOTENCY_TERMINAL_CONFLICT'; error.status=409; throw error; }
    return record;
  }

  async fail(key, error, { tenantId = null } = {}) {
    const record = await this.findByKey(key, { tenantId });
    if (!record) return null;
    if (record.status === 'failed') return record;
    if (record.status === 'completed') { const error2=new Error('Completed idempotency record cannot be failed'); error2.code='IDEMPOTENCY_TERMINAL_CONFLICT'; error2.status=409; throw error2; }
    if (record.status !== 'running') { const error2=new Error('Idempotency record is not running'); error2.code='IDEMPOTENCY_TERMINAL_CONFLICT'; error2.status=409; throw error2; }
    record.status='failed'; record.error={code:error?.code || 'EXECUTION_FAILED',message:error?.message || String(error || '')}; record.completedAt=new Date().toISOString();
    const updated=await this.db.query('UPDATE idempotency SET payload=$3,status=$4,updated_at=$5 WHERE key=$1 AND tenant_id=$2 AND status=$6',[key,tenantId || record.tenantId,record,record.status,record.completedAt,'running']);
    if(updated.rowCount!==1){const error2=new Error('Idempotency terminal transition lost a race');error2.code='IDEMPOTENCY_TERMINAL_CONFLICT';error2.status=409;throw error2;}
    return record;
  }

  async delete(key, { tenantId = 'local' } = {}) {
    const effectiveTenant = tenantOrLocal(tenantId);
    const result = await this.db.query('DELETE FROM idempotency WHERE key=$1 AND tenant_id=$2',[key,effectiveTenant]);
    return result.rowCount === 1;
  }

  async count({ tenantId = 'local' } = {}) {
    const effectiveTenant = tenantOrLocal(tenantId);
    const result = await this.db.query('SELECT COUNT(*)::int AS count FROM idempotency WHERE tenant_id=$1',[effectiveTenant]);
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

  async save(snapshot, { reason = 'step_completed', tenantId = null } = {}) {
    if (!snapshot?.executionId) throw new TypeError('snapshot.executionId is required');
    const effectiveTenant = tenantOrLocal(snapshot.tenantId || snapshot.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Checkpoint');
    const snapshotCopy = JSON.parse(JSON.stringify(snapshot));
    const digest = this.digest(snapshotCopy);
    const checkpointId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const persisted = await this.db.transaction(async client => {
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
    });
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

  async findLatest(executionId, { verify = true, tenantId = null } = {}) {
    const result = await this.db.query(
      tenantId
        ? 'SELECT * FROM checkpoints WHERE execution_id=$1 AND tenant_id=$2 ORDER BY sequence DESC LIMIT 1'
        : 'SELECT * FROM checkpoints WHERE execution_id=$1 ORDER BY sequence DESC LIMIT 1',
      tenantId ? [executionId, tenantId] : [executionId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    if (verify && row.snapshot_sha256 !== this.digest(row.snapshot)) {
      const error = new Error(`Checkpoint integrity verification failed: ${executionId}`);
      error.code = 'CHECKPOINT_INTEGRITY_FAILED';
      throw error;
    }
    return this.toModel(row);
  }

  async acquireResumeLease(executionId, { tenantId = null, leaseDurationMs = 30000 } = {}) {
    if (!executionId) throw new TypeError('executionId is required');
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new TypeError('leaseDurationMs must be a positive integer');
    }

    const effectiveTenant = tenantOrLocal(tenantId);
    const leaseId = crypto.randomUUID();
    const result = await this.db.query(
      `INSERT INTO execution_resume_leases(execution_id,tenant_id,lease_id,acquired_at,expires_at)
       SELECT c.execution_id,c.tenant_id,$3,NOW(),NOW()+($4::double precision * INTERVAL '1 millisecond')
       FROM checkpoints c
       WHERE c.execution_id=$1 AND c.tenant_id=$2
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
      [executionId, effectiveTenant, leaseId, leaseDurationMs]
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

    const checkpoint = await this.db.query(
      'SELECT 1 FROM checkpoints WHERE execution_id=$1 AND tenant_id=$2 LIMIT 1',
      [executionId, effectiveTenant]
    );
    if (!checkpoint.rows.length) return null;

    const existing = await this.db.query(
      'SELECT tenant_id,expires_at FROM execution_resume_leases WHERE execution_id=$1 LIMIT 1',
      [executionId]
    );
    if (existing.rows.length && existing.rows[0].tenant_id !== effectiveTenant) return null;

    const error = new Error('Execution resume lease is already held');
    error.code = 'CHECKPOINT_RESUME_LEASE_HELD';
    throw error;
  }

  async renewResumeLease(executionId, leaseId, { tenantId = null, leaseDurationMs = 30000 } = {}) {
    if (!executionId || !leaseId) return null;
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new TypeError('leaseDurationMs must be a positive integer');
    }
    const effectiveTenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      `UPDATE execution_resume_leases
       SET expires_at=NOW()+($4::double precision * INTERVAL '1 millisecond')
       WHERE execution_id=$1 AND tenant_id=$2 AND lease_id=$3 AND expires_at>NOW()
       RETURNING lease_id,acquired_at,expires_at`,
      [executionId, effectiveTenant, leaseId, leaseDurationMs]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      leaseId: row.lease_id,
      acquiredAt: new Date(row.acquired_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      expiresAtMs: new Date(row.expires_at).getTime()
    };
  }

  async releaseResumeLease(executionId, leaseId, { tenantId = null } = {}) {
    if (!executionId || !leaseId) return false;
    const effectiveTenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      'DELETE FROM execution_resume_leases WHERE execution_id=$1 AND tenant_id=$2 AND lease_id=$3',
      [executionId, effectiveTenant, leaseId]
    );
    return result.rowCount === 1;
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

  async save(instance, tenantId = null) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenant = tenantOrLocal(item.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Workflow');
    const fencingToken = Number(item.metadata?.fencingToken || 0);
    if (fencingToken > 0) {
      const result = await this.db.query(
        `UPDATE workflows
         SET state=$3,updated_at=$4,payload=$5
         WHERE workflow_id=$1 AND tenant_id=$2
           AND EXISTS (
             SELECT 1 FROM workflow_leases
             WHERE workflow_id=$1 AND tenant_id=$2
               AND fencing_token=$6 AND expires_at > NOW()
           )`,
        [item.workflowId, effectiveTenant, item.state, item.updatedAt || new Date().toISOString(), item, fencingToken]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Workflow write rejected by durable fencing token');
        error.code = 'WORKFLOW_FENCING_REJECTED';
        throw error;
      }
      return item;
    }
    await this.db.query(
      `INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(workflow_id) DO UPDATE SET
         tenant_id=EXCLUDED.tenant_id,state=EXCLUDED.state,
         updated_at=EXCLUDED.updated_at,payload=EXCLUDED.payload`,
      [item.workflowId, effectiveTenant, item.state, item.updatedAt || new Date().toISOString(), item]
    );
    return item;
  }

  async claimQueued({tenantId='local',workerId,limit=100,claimTtlMs=5000,workerCapabilities=[],agingQuantumMs=30000}={}) {
    if (!workerId) throw new TypeError('workerId is required');
    const safeLimit=Math.max(1,Math.min(1000,Number(limit)||100));
    const capabilities=Array.isArray(workerCapabilities)
      ? [...new Set(workerCapabilities.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))]
      : [];
    const safeAgingQuantumMs=Math.max(1000,Number(agingQuantumMs)||30000);
    const expiresAt=new Date(Date.now()+Math.max(1000,Number(claimTtlMs)||5000)).toISOString();
    return this.db.transaction(async client => {
      if (this.workerRegistry) {
        const worker = await client.query(
          'SELECT worker_id,capabilities,status,expires_at FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2 FOR UPDATE',
          [tenantId, workerId]
        );
        if (!worker.rows.length || new Date(worker.rows[0].expires_at).getTime() <= Date.now()) {
          const error = new Error('Worker is not registered or its lease has expired');
          error.code = 'WORKER_NOT_ACTIVE';
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
      await client.query('DELETE FROM workflow_dispatch_claims WHERE tenant_id=$1 AND expires_at <= NOW()',[tenantId]);
      const result=await client.query(
        `WITH candidates AS (
           SELECT w.workflow_id FROM workflows w
           WHERE w.tenant_id=$1 AND w.state IN ('QUEUED','WAITING','RECOVERING','RUNNING')
             AND COALESCE(w.payload->'metadata'->'requiredCapabilities','[]'::jsonb) <@ $4::jsonb
             AND NOT EXISTS (SELECT 1 FROM workflow_dispatch_claims c WHERE c.tenant_id=w.tenant_id AND c.workflow_id=w.workflow_id AND c.expires_at > NOW())
             AND NOT EXISTS (SELECT 1 FROM workflow_leases l WHERE l.tenant_id=w.tenant_id AND l.workflow_id=w.workflow_id AND l.expires_at > NOW())
           ORDER BY (
             COALESCE((w.payload->>'priority')::int,0)
             + FLOOR(GREATEST(0,EXTRACT(EPOCH FROM (NOW()-w.updated_at))*1000) / $5)
           ) DESC, w.updated_at ASC
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         INSERT INTO workflow_dispatch_claims(tenant_id,workflow_id,worker_id,claimed_at,expires_at)
         SELECT $1,workflow_id,$3,NOW(),$6 FROM candidates
         ON CONFLICT (tenant_id,workflow_id) DO NOTHING RETURNING workflow_id`,
        [tenantId,safeLimit,workerId,JSON.stringify(capabilities),safeAgingQuantumMs,expiresAt]
      );
      if(!result.rows.length) return [];
      const ids=result.rows.map(row=>row.workflow_id);
      const workflows=await client.query('SELECT payload FROM workflows WHERE tenant_id=$1 AND workflow_id=ANY($2::text[])',[tenantId,ids]);
      const byId=new Map(workflows.rows.map(row=>[row.payload.workflowId,row.payload]));
      return ids.map(id=>byId.get(id)).filter(Boolean);
    });
  }

  async releaseDispatchClaim(workflowId,workerId,tenantId='local') {
    const result=await this.db.query('DELETE FROM workflow_dispatch_claims WHERE tenant_id=$1 AND workflow_id=$2 AND worker_id=$3',[tenantId,workflowId,workerId]);
    return result.rowCount===1;
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

  async findById(workflowId, tenantId = null) {
    const result = await this.db.query(
      tenantId ? 'SELECT payload FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 LIMIT 1' : 'SELECT payload FROM workflows WHERE workflow_id=$1 LIMIT 1',
      tenantId ? [workflowId, tenantId] : [workflowId]
    );
    return result.rows.length ? result.rows[0].payload : null;
  }

  async findByApprovalExecutionId({ executionId, tenantId = null } = {}) {
    if (!executionId) return null;
    const values = [String(executionId)];
    let tenantClause = '';
    if (tenantId) {
      values.push(tenantId);
      tenantClause = ' AND tenant_id=$' + values.length;
    }
    const result = await this.db.query(
      "SELECT payload FROM workflows WHERE payload->'metadata'->>'approvalBlocked'='true' " +
      "AND payload->'metadata'->>'approvalExecutionId'=$1" + tenantClause +
      ' ORDER BY updated_at DESC LIMIT 1',
      values
    );
    return result.rows.length ? result.rows[0].payload : null;
  }

  async findAll({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT payload FROM workflows WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId])
      : await this.db.query('SELECT payload FROM workflows ORDER BY updated_at DESC');
    return result.rows.map(row => row.payload);
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

  async tryAcquire(lease, tenantId = null) {
    const effectiveTenant = tenantOrLocal(lease.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Lease');
    const acquiredAt = new Date(lease.acquiredAt).toISOString();
    const expiresAt = new Date(lease.expiresAt).toISOString();

    return this.db.transaction(async client => {
      const workflow = await client.query(
        'SELECT state,payload FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 FOR UPDATE',
        [lease.workflowId, effectiveTenant]
      );
      if (!workflow.rows.length) {
        const error = new Error('Workflow is not durably registered');
        error.code = 'WORKFLOW_NOT_FOUND';
        throw error;
      }
      const workflowState = workflow.rows[0].state;
      const workflowPayload = workflow.rows[0].payload || {};
      if (workflowPayload.cancelRequested || workflowState === 'CANCELLED') {
        const error = new Error('Workflow cancellation was requested');
        error.code = 'WORKFLOW_CANCELLATION_REQUESTED';
        throw error;
      }
      if (['COMPLETED','FAILED'].includes(workflowState)) {
        const error = new Error('Workflow is terminal');
        error.code = 'WORKFLOW_TERMINAL';
        throw error;
      }
      await client.query(
        'DELETE FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 AND expires_at <= $3',
        [lease.workflowId, effectiveTenant, acquiredAt]
      );
      const result = await client.query(
        `INSERT INTO workflow_leases(workflow_id,tenant_id,lease_id,worker_id,acquired_at,expires_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(workflow_id) DO NOTHING
         RETURNING fencing_token`,
        [lease.workflowId,effectiveTenant,lease.leaseId,lease.workerId,acquiredAt,expiresAt,lease]
      );
      if (result.rowCount !== 1) return null;
      return { ...lease, fencingToken: Number(result.rows[0].fencing_token) };
    });
  }

  async save(lease, tenantId = null) {
    const effectiveTenant = tenantOrLocal(lease.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Lease');
    await this.db.query(
      `INSERT INTO workflow_leases(workflow_id,tenant_id,lease_id,worker_id,acquired_at,expires_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(workflow_id) DO UPDATE SET
         tenant_id=EXCLUDED.tenant_id,lease_id=EXCLUDED.lease_id,
         worker_id=EXCLUDED.worker_id,acquired_at=EXCLUDED.acquired_at,
         expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload`,
      [lease.workflowId,effectiveTenant,lease.leaseId,lease.workerId,new Date(lease.acquiredAt).toISOString(),new Date(lease.expiresAt).toISOString(),lease]
    );
    return { ...lease };
  }

  async renewIfOwned(workflowId, leaseId, expiresAt, now = Date.now(), tenantId = null) {
    const result = await this.db.query(
      `UPDATE workflow_leases SET expires_at=$1::timestamptz,payload=jsonb_set(payload,'{expiresAt}',to_jsonb($1::timestamptz::text))
       WHERE workflow_id=$2 AND lease_id=$3 AND expires_at > $4 ${tenantId ? 'AND tenant_id=$5' : ''}`,
      tenantId
        ? [new Date(expiresAt).toISOString(), workflowId, leaseId, new Date(now).toISOString(), tenantId]
        : [new Date(expiresAt).toISOString(), workflowId, leaseId, new Date(now).toISOString()]
    );
    return result.rowCount === 1;
  }

  async findByWorkflowId(workflowId, tenantId = null) {
    const result = await this.db.query(
      tenantId ? 'SELECT payload,expires_at,acquired_at FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 LIMIT 1' : 'SELECT payload,expires_at,acquired_at FROM workflow_leases WHERE workflow_id=$1 LIMIT 1',
      tenantId ? [workflowId, tenantId] : [workflowId]
    );
    return result.rows.length ? { ...result.rows[0].payload, expiresAt: new Date(result.rows[0].expires_at).getTime(), acquiredAt: new Date(result.rows[0].acquired_at).getTime() } : null;
  }

  async findAll({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT payload,expires_at,acquired_at FROM workflow_leases WHERE tenant_id=$1 ORDER BY acquired_at ASC', [tenantId])
      : await this.db.query('SELECT payload,expires_at,acquired_at FROM workflow_leases ORDER BY acquired_at ASC');
    return result.rows.map(row => ({ ...row.payload, expiresAt: new Date(row.expires_at).getTime(), acquiredAt: new Date(row.acquired_at).getTime() }));
  }

  async delete(workflowId, leaseId, tenantId = null) {
    const result = await this.db.query(
      tenantId
        ? 'DELETE FROM workflow_leases WHERE workflow_id=$1 AND lease_id=$2 AND tenant_id=$3'
        : 'DELETE FROM workflow_leases WHERE workflow_id=$1 AND lease_id=$2',
      tenantId ? [workflowId, leaseId, tenantId] : [workflowId, leaseId]
    );
    return result.rowCount === 1;
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
    const timestamp = value => value instanceof Date ? value.toISOString() : value;
    return {
      approvalId: row.approval_id, executionId: row.execution_id, step: Number(row.step),
      planRevision: Number(row.plan_revision), tool: row.tool, capability: row.capability,
      scope: row.scope, issuedAt: timestamp(row.issued_at), expiresAt: timestamp(row.expires_at),
      used: Boolean(row.used), usedAt: row.used_at ? timestamp(row.used_at) : undefined,
      metadata: row.metadata, tenantId: row.tenant_id,
      ...(row.metadata?.decision ? { decision: row.metadata.decision } : {})
    };
  }

  async findByExecution({ executionId, step = null, tool = null, planRevision = null, tenantId = null } = {}) {
    if (!executionId) return [];
    const clauses = ['execution_id=$1'];
    const values = [String(executionId)];
    if (tenantId) { values.push(tenantId); clauses.push(`tenant_id=$${values.length}`); }
    if (step !== null) { values.push(Number(step)); clauses.push(`step=$${values.length}`); }
    if (tool !== null) { values.push(tool); clauses.push(`tool=$${values.length}`); }
    if (planRevision !== null) { values.push(Number(planRevision)); clauses.push(`plan_revision=$${values.length}`); }
    const result = await this.db.query(`SELECT * FROM approvals WHERE ${clauses.join(' AND ')} ORDER BY issued_at DESC`, values);
    return result.rows.map(row => this.mapRow(row));
  }

  async findPending({ tenantId = null, limit = 100, now = Date.now() } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    const nowIso = new Date(now).toISOString();
    const result = tenantId
      ? await this.db.query('SELECT * FROM approvals WHERE tenant_id=$1 AND used=FALSE AND expires_at>$2 ORDER BY issued_at ASC, approval_id ASC LIMIT $3', [tenantId, nowIso, boundedLimit])
      : await this.db.query('SELECT * FROM approvals WHERE used=FALSE AND expires_at>$1 ORDER BY issued_at ASC, approval_id ASC LIMIT $2', [nowIso, boundedLimit]);
    return result.rows.map(row => this.mapRow(row));
  }

  async save(approval, { tenantId = null } = {}) {
    const effectiveTenant = tenantOrLocal(approval.tenantId || approval.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Approval');
    await this.db.query(
      `INSERT INTO approvals(approval_id,tenant_id,execution_id,step,plan_revision,tool,capability,scope,issued_at,expires_at,used,used_at,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [approval.approvalId,effectiveTenant,approval.executionId,approval.step,approval.planRevision,approval.tool,approval.capability,approval.scope,approval.issuedAt,approval.expiresAt,Boolean(approval.used),approval.usedAt || null,{...(approval.metadata || {}),...(approval.decision ? { decision: approval.decision } : {}),tenantId:effectiveTenant}]
    );
    return { ...approval, tenantId: effectiveTenant };
  }

  async findById(approvalId, { tenantId = null } = {}) {
    const result = await this.db.query(
      tenantId ? 'SELECT * FROM approvals WHERE approval_id=$1 AND tenant_id=$2 LIMIT 1' : 'SELECT * FROM approvals WHERE approval_id=$1 LIMIT 1',
      tenantId ? [approvalId, tenantId] : [approvalId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return this.mapRow(row);
  }

  async recordDecision(approvalId, decision, tenantId = null, now = () => Date.now()) {
    const invalid = () => Object.assign(new TypeError('Invalid approval decision record'), { code: 'APPROVAL_DECISION_INVALID' });
    if (!approvalId || !decision || !['approved', 'rejected'].includes(decision.status) ||
        typeof decision.actorId !== 'string' || !decision.actorId.trim() ||
        typeof decision.decidedAt !== 'string') throw invalid();

    const current = await this.findById(approvalId, { tenantId });
    if (!current) throw Object.assign(new Error('Approval not found'), { code: 'APPROVAL_NOT_FOUND' });
    if (current.decision) {
      if (current.decision.status === decision.status && current.decision.actorId === decision.actorId) return current;
      throw Object.assign(new Error('Approval already has a different decision'), { code: 'APPROVAL_DECISION_CONFLICT' });
    }
    if (current.used) throw Object.assign(new Error('Approval already consumed'), { code: 'APPROVAL_ALREADY_USED' });
    const decisionNow = typeof now === 'function' ? now() : now;
    const expiresAt = typeof current.expiresAt === 'string' ? Date.parse(current.expiresAt) : NaN;
    if (!Number.isFinite(decisionNow) || !Number.isFinite(expiresAt) || decisionNow >= expiresAt) {
      throw Object.assign(new Error('Approval expired or has an invalid expiry timestamp'), { code: 'APPROVAL_EXPIRED' });
    }

    const nowIso = new Date(decisionNow).toISOString();
    const values = [JSON.stringify(decision), nowIso, approvalId];
    let tenantClause = '';
    if (tenantId) { values.push(tenantId); tenantClause = ' AND tenant_id=
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
  PostgresWorkerRegistryRepository
};
 + values.length; }
    const result = await this.db.query(
      "UPDATE approvals SET metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('decision',$1::jsonb) " +
      "WHERE approval_id=$3" + tenantClause +
      " AND used=FALSE AND expires_at>$2 AND expires_at>clock_timestamp() " +
      "AND NOT (COALESCE(metadata,'{}'::jsonb) ? 'decision')",
      values
    );
    if (result.rowCount === 1) return this.findById(approvalId, { tenantId });

    const latest = await this.findById(approvalId, { tenantId });
    if (latest?.decision?.status === decision.status && latest.decision.actorId === decision.actorId) return latest;
    if (latest?.used) throw Object.assign(new Error('Approval already consumed'), { code: 'APPROVAL_ALREADY_USED' });
    const latestNow = typeof now === 'function' ? now() : now;
    const latestExpiry = typeof latest?.expiresAt === 'string' ? Date.parse(latest.expiresAt) : NaN;
    if (latest && (!Number.isFinite(latestExpiry) || !Number.isFinite(latestNow) || latestNow >= latestExpiry)) {
      throw Object.assign(new Error('Approval expired or has an invalid expiry timestamp'), { code: 'APPROVAL_EXPIRED' });
    }
    throw Object.assign(new Error('Approval already has a different decision'), { code: 'APPROVAL_DECISION_CONFLICT' });
  }

  async consume(approvalId, usedAt, tenantId = null, now = () => Date.now()) {
    const requestedAt = typeof usedAt === 'string' ? Date.parse(usedAt) : NaN;
    const commitNow = typeof now === 'function' ? now() : now;
    if (!Number.isFinite(requestedAt) || !Number.isFinite(commitNow)) return false;
    const commitAt = new Date(commitNow).toISOString();
    const tenantClause = tenantId ? ' AND tenant_id=$4' : '';
    const values = tenantId
      ? [usedAt, commitAt, approvalId, tenantId]
      : [usedAt, commitAt, approvalId];
    const result = await this.db.query(
      "UPDATE approvals SET used=TRUE,used_at=$2 WHERE approval_id=$3" + tenantClause +
      " AND used=FALSE AND metadata->'decision'->>'status'='approved' " +
      "AND expires_at>$1::timestamptz AND expires_at>$2::timestamptz AND expires_at>clock_timestamp()",
      values
    );
    return result.rowCount === 1;
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
  PostgresWorkerRegistryRepository
};
