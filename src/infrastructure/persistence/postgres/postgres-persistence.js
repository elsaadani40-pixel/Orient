const crypto = require('crypto');
const { PostgresDatabase } = require('./postgres-database');
const PostgresTenantQuotaRepository = require('./postgres-tenant-quota-repository');

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
      updatedAt: execution.updatedAt || new Date().toISOString()
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
      id: current.id,
      executionId: current.executionId,
      tenantId: effectiveTenant,
      updatedAt: new Date().toISOString()
    };
    await this.db.query(
      'UPDATE executions SET payload=$3,updated_at=$4 WHERE execution_id=$1 AND tenant_id=$2',
      [executionId, effectiveTenant, updated, updated.updatedAt]
    );
    return updated;
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

  async findByExecutionId(id, { tenantId = null } = {}) {
    const result = await this.db.query(tenantId ? 'SELECT payload FROM events WHERE tenant_id=$1 AND execution_id=$2 ORDER BY timestamp ASC' : 'SELECT payload FROM events WHERE execution_id=$1 ORDER BY timestamp ASC', tenantId ? [tenantId,id] : [id]); return result.rows.map(row => row.payload);
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
    record.status = 'completed'; record.result = result ?? null; record.completedAt = new Date().toISOString();
    await this.db.query('UPDATE idempotency SET payload=$3,status=$4,updated_at=$5 WHERE key=$1 AND tenant_id=$2',
      [key, tenantId || record.tenantId, record, record.status, record.completedAt]);
    return record;
  }

  async fail(key, error, { tenantId = null } = {}) {
    const record = await this.findByKey(key, { tenantId });
    if (!record) return null;
    record.status = 'failed'; record.error = { code: error?.code || 'EXECUTION_FAILED', message: error?.message || String(error || '') }; record.completedAt = new Date().toISOString();
    await this.db.query('UPDATE idempotency SET payload=$3,status=$4,updated_at=$5 WHERE key=$1 AND tenant_id=$2',
      [key, tenantId || record.tenantId, record, record.status, record.completedAt]);
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

  digest(snapshot) {
    return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
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
  constructor(db) { this.db = db; }

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

  async findById(workflowId, tenantId = null) {
    const result = await this.db.query(
      tenantId ? 'SELECT payload FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 LIMIT 1' : 'SELECT payload FROM workflows WHERE workflow_id=$1 LIMIT 1',
      tenantId ? [workflowId, tenantId] : [workflowId]
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
      `UPDATE workflow_leases SET expires_at=$1,payload=jsonb_set(payload,'{expiresAt}',to_jsonb($1::text))
       WHERE workflow_id=$2 AND lease_id=$3 AND expires_at > $4 ${tenantId ? 'AND tenant_id=$5' : ''}`,
      tenantId
        ? [new Date(expiresAt).toISOString(), workflowId, leaseId, new Date(now).toISOString(), tenantId]
        : [new Date(expiresAt).toISOString(), workflowId, leaseId, new Date(now).toISOString()]
    );
    return result.rowCount === 1;
  }

  async findByWorkflowId(workflowId, tenantId = null) {
    const result = await this.db.query(
      tenantId ? 'SELECT payload FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2 LIMIT 1' : 'SELECT payload FROM workflow_leases WHERE workflow_id=$1 LIMIT 1',
      tenantId ? [workflowId, tenantId] : [workflowId]
    );
    return result.rows.length ? result.rows[0].payload : null;
  }

  async findAll({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT payload FROM workflow_leases WHERE tenant_id=$1 ORDER BY acquired_at ASC', [tenantId])
      : await this.db.query('SELECT payload FROM workflow_leases ORDER BY acquired_at ASC');
    return result.rows.map(row => row.payload);
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

  async save(approval, { tenantId = null } = {}) {
    const effectiveTenant = tenantOrLocal(approval.tenantId || approval.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Approval');
    await this.db.query(
      `INSERT INTO approvals(approval_id,tenant_id,execution_id,step,plan_revision,tool,capability,scope,issued_at,expires_at,used,used_at,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [approval.approvalId,effectiveTenant,approval.executionId,approval.step,approval.planRevision,approval.tool,approval.capability,approval.scope,approval.issuedAt,approval.expiresAt,Boolean(approval.used),approval.usedAt || null,{...(approval.metadata || {}),tenantId:effectiveTenant}]
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
    return {
      approvalId: row.approval_id, executionId: row.execution_id, step: Number(row.step),
      planRevision: Number(row.plan_revision), tool: row.tool, capability: row.capability,
      scope: row.scope, issuedAt: row.issued_at, expiresAt: row.expires_at,
      used: Boolean(row.used), usedAt: row.used_at || undefined,
      metadata: row.metadata, tenantId: row.tenant_id
    };
  }

  async consume(approvalId, usedAt, tenantId = null) {
    const result = await this.db.query(
      tenantId
        ? 'UPDATE approvals SET used=TRUE,used_at=$1 WHERE approval_id=$2 AND tenant_id=$3 AND used=FALSE AND expires_at>$1'
        : 'UPDATE approvals SET used=TRUE,used_at=$1 WHERE approval_id=$2 AND used=FALSE AND expires_at>$1',
      tenantId ? [usedAt, approvalId, tenantId] : [usedAt, approvalId]
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
    this.workflows = new PostgresWorkflowRepository(this.db);
    this.workflowLeases = new PostgresWorkflowLeaseRepository(this.db);
    this.approvals = new PostgresApprovalRepository(this.db);
    this.tenantQuotas = new PostgresTenantQuotaRepository(this.db);
  }

  initialize() {
    return this.db.initialize();
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
  PostgresApprovalRepository
};
