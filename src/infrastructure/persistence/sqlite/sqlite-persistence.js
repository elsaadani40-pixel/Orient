const crypto = require('crypto');
const SqliteDatabase = require('./sqlite-database');
const { SqliteWorkflowRepository, SqliteWorkflowLeaseRepository } = require('./workflow.repository');

class SqliteExecutionRepository {
  constructor(db) { this.db = db; }

  normalize(execution) {
    const now = new Date().toISOString();
    return {
      ...execution,
      id: execution.id || execution.executionId || crypto.randomUUID(),
      executionId: execution.executionId || execution.id || crypto.randomUUID(),
      executionVersion: Number(execution.executionVersion || 1),
      status: execution.status || 'created',
      agentLifecycle: execution.agentLifecycle || 'created',
      metadata: execution.metadata && typeof execution.metadata === 'object' ? { ...execution.metadata } : {},
      steps: Array.isArray(execution.steps) ? [...execution.steps] : [],
      observations: Array.isArray(execution.observations) ? [...execution.observations] : [],
      events: Array.isArray(execution.events) ? [...execution.events] : [],
      updatedAt: execution.updatedAt || now
    };
  }

  findById(executionId, { tenantId = null } = {}) {
    const rows = this.db.query(`SELECT payload FROM executions WHERE execution_id=${SqliteDatabase.literal(executionId)} LIMIT 1;`);
    if (!rows.length) return null;
    const item = JSON.parse(rows[0].payload);
    return tenantId && item.metadata?.tenantId !== tenantId && !(tenantId === 'local' && !item.metadata?.tenantId) ? null : item;
  }

  findAll({ tenantId = null } = {}) {
    return this.db.query('SELECT payload FROM executions ORDER BY updated_at DESC;').map(row => JSON.parse(row.payload)).filter(item => !tenantId || item.metadata?.tenantId === tenantId || (tenantId === 'local' && !item.metadata?.tenantId));
  }
  findPage({ tenantId = null, limit = 50, offset = 0 } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
    const boundedOffset = Number.isInteger(offset) ? Math.max(0, Math.min(offset, 10000)) : 0;
    let where = '';
    if (tenantId) {
      const tenant = SqliteDatabase.literal(tenantId);
      where = tenantId === 'local'
        ? " WHERE (json_extract(payload, '$.metadata.tenantId')=" + tenant + " OR json_extract(payload, '$.metadata.tenantId') IS NULL)"
        : " WHERE json_extract(payload, '$.metadata.tenantId')=" + tenant;
    }
    const total = Number(this.db.query('SELECT COUNT(*) AS total FROM executions' + where + ';')[0]?.total || 0);
    const rows = this.db.query('SELECT payload FROM executions' + where + ' ORDER BY updated_at DESC, execution_id DESC LIMIT ' + boundedLimit + ' OFFSET ' + boundedOffset + ';');
    return { total, limit: boundedLimit, offset: boundedOffset, executions: rows.map(row => JSON.parse(row.payload)) };
  }


  findByGoalId(goalId, { tenantId = null } = {}) {
    return this.findAll({ tenantId }).filter(item => item.goalId === goalId);
  }

  insert(execution, { tenantId = null } = {}) {
    const normalized = this.normalize(execution);
    if (tenantId && normalized.metadata?.tenantId !== tenantId) throw new Error('Execution tenant mismatch');
    const exists = this.findById(normalized.executionId, { tenantId });
    if (exists) throw new Error(`Execution already exists: ${normalized.executionId}`);
    this.db.run(`INSERT INTO executions(execution_id,payload,updated_at) VALUES (${SqliteDatabase.literal(normalized.executionId)},${SqliteDatabase.json(normalized)},${SqliteDatabase.literal(normalized.updatedAt)});`);
    return normalized;
  }

  update(executionId, patch, { tenantId = null } = {}) {
    const current = this.findById(executionId, { tenantId });
    if (!current) return null;
    const updated = this.normalize({ ...current, ...patch, id: current.id, executionId: current.executionId, updatedAt: new Date().toISOString() });
    this.db.run(`UPDATE executions SET payload=${SqliteDatabase.json(updated)}, updated_at=${SqliteDatabase.literal(updated.updatedAt)} WHERE execution_id=${SqliteDatabase.literal(executionId)};`);
    return updated;
  }

  deleteById(executionId, { tenantId = null } = {}) {
    const before = this.findById(executionId, { tenantId });
    if (!before) return false;
    this.db.run(`DELETE FROM executions WHERE execution_id=${SqliteDatabase.literal(executionId)};`);
    return true;
  }

  count() {
    return this.db.query('SELECT COUNT(*) AS count FROM executions;')[0].count;
  }
}

class SqliteEventRepository {
  constructor(db) { this.db = db; }
  normalize(event) {
    return {
      id: event.id || crypto.randomUUID(),
      type: event.type,
      executionId: event.executionId || null,
      goalId: event.goalId || null,
      timestamp: event.timestamp || new Date().toISOString(),
      data: event.data && typeof event.data === 'object' ? { ...event.data } : {}
    };
  }
  append(event, { tenantId = null } = {}) {
    const normalized = this.normalize(event);
    if (tenantId && normalized.data?.tenantId && normalized.data.tenantId !== tenantId) throw new Error('Event tenant mismatch');
    if (tenantId && !normalized.data?.tenantId) normalized.data.tenantId = tenantId;
    this.db.run(`INSERT OR IGNORE INTO events(event_id,execution_id,goal_id,type,timestamp,payload) VALUES (${SqliteDatabase.literal(normalized.id)},${SqliteDatabase.literal(normalized.executionId)},${SqliteDatabase.literal(normalized.goalId)},${SqliteDatabase.literal(normalized.type)},${SqliteDatabase.literal(normalized.timestamp)},${SqliteDatabase.json(normalized)});`);
    return normalized;
  }
  appendMany(events, { tenantId = null } = {}) {
    const unique = [];
    const statements = [];
    for (const event of events || []) {
      const normalized = this.normalize(event);
      if (tenantId && normalized.data?.tenantId && normalized.data.tenantId !== tenantId) throw new Error('Event tenant mismatch');
      if (tenantId && !normalized.data?.tenantId) normalized.data.tenantId = tenantId;
      const exists = this.db.query(`SELECT 1 FROM events WHERE event_id=${SqliteDatabase.literal(normalized.id)} LIMIT 1;`).length;
      if (!exists) {
        unique.push(normalized);
        statements.push(`INSERT INTO events(event_id,execution_id,goal_id,type,timestamp,payload) VALUES (${SqliteDatabase.literal(normalized.id)},${SqliteDatabase.literal(normalized.executionId)},${SqliteDatabase.literal(normalized.goalId)},${SqliteDatabase.literal(normalized.type)},${SqliteDatabase.literal(normalized.timestamp)},${SqliteDatabase.json(normalized)});`);
      }
    }
    if (statements.length) this.db.transaction(statements);
    return unique;
  }
  findAll({ tenantId = null } = {}) { return this.db.query('SELECT payload FROM events ORDER BY timestamp ASC;').map(row => JSON.parse(row.payload)).filter(item => !tenantId || item.data?.tenantId === tenantId || (tenantId === 'local' && !item.data?.tenantId)); }
  findByExecutionId(id, { tenantId = null, limit = null } = {}) {
    let where = ' WHERE execution_id=' + SqliteDatabase.literal(id);
    if (tenantId) {
      const tenant = SqliteDatabase.literal(tenantId);
      where += tenantId === 'local'
        ? " AND (json_extract(payload, '$.data.tenantId')=" + tenant + " OR json_extract(payload, '$.data.tenantId') IS NULL)"
        : " AND json_extract(payload, '$.data.tenantId')=" + tenant;
    }
    if (Number.isInteger(limit) && limit > 0) {
      const boundedLimit = Math.min(limit, 200);
      return this.db.query('SELECT payload FROM events' + where + ' ORDER BY timestamp DESC, event_id DESC LIMIT ' + boundedLimit + ';')
        .map(row => JSON.parse(row.payload)).reverse();
    }
    return this.db.query('SELECT payload FROM events' + where + ' ORDER BY timestamp ASC, event_id ASC;')
      .map(row => JSON.parse(row.payload));
  }
  findByGoalId(id, { tenantId = null } = {}) { return this.findAll({ tenantId }).filter(item => item.goalId === id); }
  findByType(type, { tenantId = null } = {}) { return this.findAll({ tenantId }).filter(item => item.type === type); }
  count() { return this.db.query('SELECT COUNT(*) AS count FROM events;')[0].count; }
  clear() { this.db.run('DELETE FROM events;'); }
}

class SqliteIdempotencyRepository {
  constructor(db) { this.db = db; }
  buildKey({ executionId, step, tool, planRevision = 1, operationId = null } = {}) {
    if (!executionId) throw new TypeError('executionId is required');
    if (step === undefined || step === null) throw new TypeError('step is required');
    if (!tool) throw new TypeError('tool is required');
    return operationId || `${executionId}:plan-${planRevision}:step-${step}:${tool}`;
  }
  findByKey(key, { tenantId = null } = {}) {
    const rows = this.db.query(`SELECT payload FROM idempotency WHERE key=${SqliteDatabase.literal(key)} LIMIT 1;`);
    if (!rows.length) return null;
    const item = JSON.parse(rows[0].payload);
    return tenantId && item.tenantId !== tenantId && !(tenantId === 'local' && !item.tenantId) ? null : item;
  }
  find(args) { return this.findByKey(this.buildKey(args), { tenantId: args?.tenantId || null }); }
  begin(args) {
    const key = this.buildKey(args);
    const raw = this.db.query(`SELECT payload FROM idempotency WHERE key=${SqliteDatabase.literal(key)} LIMIT 1;`);
    if (raw.length) {
      const existingRecord = JSON.parse(raw[0].payload);
      if (args?.tenantId && existingRecord.tenantId !== args.tenantId && !(args.tenantId === 'local' && !existingRecord.tenantId)) throw new Error('Idempotency tenant mismatch');
      return { created: false, key, record: existingRecord };
    }
    const existing = this.findByKey(key, { tenantId: args?.tenantId || null });
    if (existing) return { created: false, key, record: existing };
    const record = {
      id: crypto.randomUUID(),
      key,
      executionId: args.executionId,
      step: args.step,
      tool: args.tool,
      planRevision: args.planRevision || 1,
      operationId: args.operationId || null,
      tenantId: args.tenantId || null,
      status: 'running',
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null
    };
    const inserted = this.db.query(`INSERT OR IGNORE INTO idempotency(key,payload,status,updated_at) VALUES (${SqliteDatabase.literal(key)},${SqliteDatabase.json(record)},'running',${SqliteDatabase.literal(record.startedAt)}); SELECT changes() AS changes;`);
    const actual = this.findByKey(key, { tenantId: args?.tenantId || null });
    if (!inserted.length || Number(inserted[inserted.length - 1].changes) !== 1) {
      return { created: false, key, record: actual };
    }
    return { created: true, key, record: actual };
  }
  complete(key, result, { tenantId = null } = {}) {
    const record = this.findByKey(key, { tenantId }); if (!record) return null;
    record.status = 'completed'; record.result = result ?? null; record.completedAt = new Date().toISOString();
    this.db.run(`UPDATE idempotency SET payload=${SqliteDatabase.json(record)},status='completed',updated_at=${SqliteDatabase.literal(record.completedAt)} WHERE key=${SqliteDatabase.literal(key)};`);
    return record;
  }
  fail(key, error, { tenantId = null } = {}) {
    const record = this.findByKey(key, { tenantId }); if (!record) return null;
    record.status = 'failed'; record.error = { code: error?.code || 'EXECUTION_FAILED', message: error?.message || String(error || '') }; record.completedAt = new Date().toISOString();
    this.db.run(`UPDATE idempotency SET payload=${SqliteDatabase.json(record)},status='failed',updated_at=${SqliteDatabase.literal(record.completedAt)} WHERE key=${SqliteDatabase.literal(key)};`);
    return record;
  }
  delete(key, { tenantId = null } = {}) { const found=this.findByKey(key, { tenantId }); if(!found)return false; this.db.run(`DELETE FROM idempotency WHERE key=${SqliteDatabase.literal(key)};`); return true; }
  clear() { this.db.run('DELETE FROM idempotency;'); }
  count() { return this.db.query('SELECT COUNT(*) AS count FROM idempotency;')[0].count; }
}

class SqliteCheckpointRepository {
  constructor(db) { this.db = db; }
  digest(snapshot) { return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
  save(snapshot, { reason = 'step_completed', tenantId = null } = {}) {
    if (!snapshot?.executionId) throw new TypeError('snapshot.executionId is required');
    if (tenantId && snapshot.tenantId !== tenantId && snapshot.metadata?.tenantId !== tenantId) throw new Error('Checkpoint tenant mismatch');
    const existingRows = this.db.query(`SELECT snapshot FROM checkpoints WHERE execution_id=${SqliteDatabase.literal(snapshot.executionId)} LIMIT 1;`);
    if (existingRows.length && tenantId) {
      const existingSnapshot = JSON.parse(existingRows[0].snapshot);
      const existingTenantId = existingSnapshot.tenantId || existingSnapshot.metadata?.tenantId || (tenantId === 'local' ? 'local' : null);
      if (existingTenantId !== tenantId) throw new Error('Checkpoint tenant collision');
    }
    const checkpointId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const normalizedSnapshot = JSON.parse(JSON.stringify(snapshot));
    const snapshotSha256 = this.digest(normalizedSnapshot);

    // Sequence allocation and replacement happen under one SQLite write transaction.
    // This prevents concurrent writers from allocating the same checkpoint sequence.
    this.db.transaction([
      `INSERT INTO checkpoints(execution_id,sequence,checkpoint_id,reason,created_at,snapshot,snapshot_sha256)
       SELECT ${SqliteDatabase.literal(snapshot.executionId)},
              COALESCE((SELECT MAX(sequence) FROM checkpoints WHERE execution_id=${SqliteDatabase.literal(snapshot.executionId)}),0)+1,
              ${SqliteDatabase.literal(checkpointId)},
              ${SqliteDatabase.literal(reason)},
              ${SqliteDatabase.literal(createdAt)},
              ${SqliteDatabase.json(normalizedSnapshot)},
              ${SqliteDatabase.literal(snapshotSha256)}
       ON CONFLICT(execution_id) DO UPDATE SET
         sequence=excluded.sequence,
         checkpoint_id=excluded.checkpoint_id,
         reason=excluded.reason,
         created_at=excluded.created_at,
         snapshot=excluded.snapshot,
         snapshot_sha256=excluded.snapshot_sha256;`
    ]);

    const persisted = this.findLatest(snapshot.executionId, { verify: false, tenantId });
    return persisted;
  }
  findLatest(executionId, { verify = true, tenantId = null } = {}) {
    const rows = this.db.query(`SELECT * FROM checkpoints WHERE execution_id=${SqliteDatabase.literal(executionId)} LIMIT 1;`);
    if (!rows.length) return null;
    const row=rows[0], snapshot=JSON.parse(row.snapshot);
    if (tenantId && snapshot.tenantId && snapshot.tenantId !== tenantId) return null;
    if (tenantId && !snapshot.tenantId && snapshot.metadata?.tenantId && snapshot.metadata.tenantId !== tenantId) return null;
    if (tenantId && !snapshot.tenantId && !snapshot.metadata?.tenantId && tenantId !== 'local') return null;
    if (verify && row.snapshot_sha256 !== this.digest(snapshot)) {
      const error=new Error(`Checkpoint integrity verification failed: ${executionId}`); error.code='CHECKPOINT_INTEGRITY_FAILED'; throw error;
    }
    return { checkpointId:row.checkpoint_id, executionId:row.execution_id, sequence:Number(row.sequence), reason:row.reason, createdAt:row.created_at, snapshot, snapshotSha256:row.snapshot_sha256 };
  }
  delete(executionId, { tenantId = null } = {}) { const found=this.findLatest(executionId,{verify:false, tenantId}); if(!found)return false; this.db.run(`DELETE FROM checkpoints WHERE execution_id=${SqliteDatabase.literal(executionId)};`); return true; }
  clear() { this.db.run('DELETE FROM checkpoints;'); }
  count() { return this.db.query('SELECT COUNT(*) AS count FROM checkpoints;')[0].count; }
}

class SqliteApprovalRepository {
  constructor(db) { this.db = db; }

  mapRow(r) {
    const metadata = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    return {
      approvalId: r.approval_id,
      executionId: r.execution_id,
      step: Number(r.step),
      planRevision: Number(r.plan_revision),
      tool: r.tool,
      capability: r.capability,
      scope: typeof r.scope === 'string' ? JSON.parse(r.scope) : (r.scope || {}),
      issuedAt: r.issued_at,
      expiresAt: r.expires_at,
      used: Boolean(r.used),
      usedAt: r.used_at || undefined,
      metadata,
      tenantId: metadata?.tenantId || null
    };
  }
  findByExecution({ executionId, step = null, tool = null, planRevision = null, tenantId = null } = {}) {
    if (!executionId) return [];
    return this.db.query('SELECT * FROM approvals WHERE execution_id=' + SqliteDatabase.literal(String(executionId)) + ' ORDER BY issued_at DESC;')
      .map(row => this.mapRow(row))
      .filter(record => !tenantId || record.tenantId === tenantId)
      .filter(record => step === null || Number(record.step) === Number(step))
      .filter(record => tool === null || record.tool === tool)
      .filter(record => planRevision === null || Number(record.planRevision || 1) === Number(planRevision));
  }
  findPending({ tenantId = null, limit = 100, now = Date.now() } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    const nowIso = SqliteDatabase.literal(new Date(now).toISOString());
    let where = ' WHERE used=0 AND expires_at>' + nowIso;
    if (tenantId) {
      const tenant = SqliteDatabase.literal(tenantId);
      where += tenantId === 'local'
        ? " AND (json_extract(metadata, '$.tenantId')=" + tenant + " OR json_extract(metadata, '$.tenantId') IS NULL)"
        : " AND json_extract(metadata, '$.tenantId')=" + tenant;
    }
    return this.db.query('SELECT * FROM approvals' + where + ' ORDER BY issued_at ASC, approval_id ASC LIMIT ' + boundedLimit + ';')
      .map(row => this.mapRow(row))
      .filter(record => !record.used && (!record.expiresAt || now < Date.parse(record.expiresAt)));
  }  save(approval, { tenantId = null } = {}) {
    if (tenantId && approval.tenantId !== tenantId && approval.metadata?.tenantId !== tenantId) throw new Error('Approval tenant mismatch');
    this.db.run(`INSERT INTO approvals(approval_id,execution_id,step,plan_revision,tool,capability,scope,issued_at,expires_at,used,used_at,metadata) VALUES (${SqliteDatabase.literal(approval.approvalId)},${SqliteDatabase.literal(approval.executionId)},${approval.step},${approval.planRevision},${SqliteDatabase.literal(approval.tool)},${SqliteDatabase.literal(approval.capability)},${SqliteDatabase.json(approval.scope)},${SqliteDatabase.literal(approval.issuedAt)},${SqliteDatabase.literal(approval.expiresAt)},${approval.used ? 1 : 0},${SqliteDatabase.literal(approval.usedAt || null)},${SqliteDatabase.json(approval.metadata)});`);
    return { ...approval };
  }
  findById(approvalId, { tenantId = null } = {}) {
    const rows=this.db.query(`SELECT * FROM approvals WHERE approval_id=${SqliteDatabase.literal(approvalId)} LIMIT 1;`);
    if(!rows.length)return null;
    const record = this.mapRow(rows[0]);
    if (tenantId && record.tenantId !== tenantId) return null;
    return record;
  }
  consume(approvalId, usedAt, tenantId = null) {
    const current = this.findById(approvalId, { tenantId });
    if (!current) return false;
    const result=this.db.query(`UPDATE approvals SET used=1,used_at=${SqliteDatabase.literal(usedAt)} WHERE approval_id=${SqliteDatabase.literal(approvalId)} AND used=0; SELECT changes() AS changes;`);
    return Boolean(result.length && Number(result[result.length - 1].changes) === 1);
  }
  count() { return this.db.query('SELECT COUNT(*) AS count FROM approvals;')[0].count; }
}

class SqlitePersistence {
  constructor({ filePath, binary = 'sqlite3' } = {}) {
    this.db = new SqliteDatabase(filePath, { binary });
    this.executions = new SqliteExecutionRepository(this.db);
    this.events = new SqliteEventRepository(this.db);
    this.idempotency = new SqliteIdempotencyRepository(this.db);
    this.checkpoints = new SqliteCheckpointRepository(this.db);
    this.approvals = new SqliteApprovalRepository(this.db);
    this.workflows = new SqliteWorkflowRepository(this.db);
    this.workflowLeases = new SqliteWorkflowLeaseRepository(this.db);
  }
}

module.exports = SqlitePersistence;
