const crypto = require('crypto');
const SqliteDatabase = require('./sqlite-database');

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

  findById(executionId) {
    const rows = this.db.query(`SELECT payload FROM executions WHERE execution_id=${SqliteDatabase.literal(executionId)} LIMIT 1;`);
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }

  findAll() {
    return this.db.query('SELECT payload FROM executions ORDER BY updated_at DESC;').map(row => JSON.parse(row.payload));
  }

  findByGoalId(goalId) {
    return this.findAll().filter(item => item.goalId === goalId);
  }

  insert(execution) {
    const normalized = this.normalize(execution);
    const exists = this.findById(normalized.executionId);
    if (exists) throw new Error(`Execution already exists: ${normalized.executionId}`);
    this.db.run(`INSERT INTO executions(execution_id,payload,updated_at) VALUES (${SqliteDatabase.literal(normalized.executionId)},${SqliteDatabase.json(normalized)},${SqliteDatabase.literal(normalized.updatedAt)});`);
    return normalized;
  }

  update(executionId, patch) {
    const current = this.findById(executionId);
    if (!current) return null;
    const updated = this.normalize({ ...current, ...patch, id: current.id, executionId: current.executionId, updatedAt: new Date().toISOString() });
    this.db.run(`UPDATE executions SET payload=${SqliteDatabase.json(updated)}, updated_at=${SqliteDatabase.literal(updated.updatedAt)} WHERE execution_id=${SqliteDatabase.literal(executionId)};`);
    return updated;
  }

  deleteById(executionId) {
    const before = this.findById(executionId);
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
  append(event) {
    const normalized = this.normalize(event);
    this.db.run(`INSERT OR IGNORE INTO events(event_id,execution_id,goal_id,type,timestamp,payload) VALUES (${SqliteDatabase.literal(normalized.id)},${SqliteDatabase.literal(normalized.executionId)},${SqliteDatabase.literal(normalized.goalId)},${SqliteDatabase.literal(normalized.type)},${SqliteDatabase.literal(normalized.timestamp)},${SqliteDatabase.json(normalized)});`);
    return normalized;
  }
  appendMany(events) {
    const unique = [];
    const statements = [];
    for (const event of events || []) {
      const normalized = this.normalize(event);
      const exists = this.db.query(`SELECT 1 FROM events WHERE event_id=${SqliteDatabase.literal(normalized.id)} LIMIT 1;`).length;
      if (!exists) {
        unique.push(normalized);
        statements.push(`INSERT INTO events(event_id,execution_id,goal_id,type,timestamp,payload) VALUES (${SqliteDatabase.literal(normalized.id)},${SqliteDatabase.literal(normalized.executionId)},${SqliteDatabase.literal(normalized.goalId)},${SqliteDatabase.literal(normalized.type)},${SqliteDatabase.literal(normalized.timestamp)},${SqliteDatabase.json(normalized)});`);
      }
    }
    if (statements.length) this.db.transaction(statements);
    return unique;
  }
  findAll() { return this.db.query('SELECT payload FROM events ORDER BY timestamp ASC;').map(row => JSON.parse(row.payload)); }
  findByExecutionId(id) { return this.db.query(`SELECT payload FROM events WHERE execution_id=${SqliteDatabase.literal(id)} ORDER BY timestamp ASC;`).map(row => JSON.parse(row.payload)); }
  findByGoalId(id) { return this.db.query(`SELECT payload FROM events WHERE goal_id=${SqliteDatabase.literal(id)} ORDER BY timestamp ASC;`).map(row => JSON.parse(row.payload)); }
  findByType(type) { return this.db.query(`SELECT payload FROM events WHERE type=${SqliteDatabase.literal(type)} ORDER BY timestamp ASC;`).map(row => JSON.parse(row.payload)); }
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
  findByKey(key) {
    const rows = this.db.query(`SELECT payload FROM idempotency WHERE key=${SqliteDatabase.literal(key)} LIMIT 1;`);
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }
  find(args) { return this.findByKey(this.buildKey(args)); }
  begin(args) {
    const key = this.buildKey(args);
    const existing = this.findByKey(key);
    if (existing) return { created: false, key, record: existing };
    const record = {
      id: crypto.randomUUID(),
      key,
      executionId: args.executionId,
      step: args.step,
      tool: args.tool,
      planRevision: args.planRevision || 1,
      operationId: args.operationId || null,
      status: 'running',
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null
    };
    this.db.run(`INSERT INTO idempotency(key,payload,status,updated_at) VALUES (${SqliteDatabase.literal(key)},${SqliteDatabase.json(record)},'running',${SqliteDatabase.literal(record.startedAt)});`);
    return { created: true, key, record };
  }
  complete(key, result) {
    const record = this.findByKey(key); if (!record) return null;
    record.status = 'completed'; record.result = result ?? null; record.completedAt = new Date().toISOString();
    this.db.run(`UPDATE idempotency SET payload=${SqliteDatabase.json(record)},status='completed',updated_at=${SqliteDatabase.literal(record.completedAt)} WHERE key=${SqliteDatabase.literal(key)};`);
    return record;
  }
  fail(key, error) {
    const record = this.findByKey(key); if (!record) return null;
    record.status = 'failed'; record.error = { code: error?.code || 'EXECUTION_FAILED', message: error?.message || String(error || '') }; record.completedAt = new Date().toISOString();
    this.db.run(`UPDATE idempotency SET payload=${SqliteDatabase.json(record)},status='failed',updated_at=${SqliteDatabase.literal(record.completedAt)} WHERE key=${SqliteDatabase.literal(key)};`);
    return record;
  }
  delete(key) { const found=this.findByKey(key); if(!found)return false; this.db.run(`DELETE FROM idempotency WHERE key=${SqliteDatabase.literal(key)};`); return true; }
  clear() { this.db.run('DELETE FROM idempotency;'); }
  count() { return this.db.query('SELECT COUNT(*) AS count FROM idempotency;')[0].count; }
}

class SqliteCheckpointRepository {
  constructor(db) { this.db = db; }
  digest(snapshot) { return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
  save(snapshot, { reason = 'step_completed' } = {}) {
    if (!snapshot?.executionId) throw new TypeError('snapshot.executionId is required');
    const previous = this.findLatest(snapshot.executionId, { verify: false });
    const sequence = Number(previous?.sequence || 0) + 1;
    const checkpoint = {
      checkpointId: crypto.randomUUID(),
      executionId: snapshot.executionId,
      sequence,
      reason,
      createdAt: new Date().toISOString(),
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      snapshotSha256: this.digest(snapshot)
    };
    this.db.run(`INSERT INTO checkpoints(execution_id,sequence,checkpoint_id,reason,created_at,snapshot,snapshot_sha256) VALUES (${SqliteDatabase.literal(checkpoint.executionId)},${sequence},${SqliteDatabase.literal(checkpoint.checkpointId)},${SqliteDatabase.literal(reason)},${SqliteDatabase.literal(checkpoint.createdAt)},${SqliteDatabase.json(checkpoint.snapshot)},${SqliteDatabase.literal(checkpoint.snapshotSha256)}) ON CONFLICT(execution_id) DO UPDATE SET sequence=excluded.sequence,checkpoint_id=excluded.checkpoint_id,reason=excluded.reason,created_at=excluded.created_at,snapshot=excluded.snapshot,snapshot_sha256=excluded.snapshot_sha256;`);
    return checkpoint;
  }
  findLatest(executionId, { verify = true } = {}) {
    const rows = this.db.query(`SELECT * FROM checkpoints WHERE execution_id=${SqliteDatabase.literal(executionId)} LIMIT 1;`);
    if (!rows.length) return null;
    const row=rows[0], snapshot=JSON.parse(row.snapshot);
    if (verify && row.snapshot_sha256 !== this.digest(snapshot)) {
      const error=new Error(`Checkpoint integrity verification failed: ${executionId}`); error.code='CHECKPOINT_INTEGRITY_FAILED'; throw error;
    }
    return { checkpointId:row.checkpoint_id, executionId:row.execution_id, sequence:Number(row.sequence), reason:row.reason, createdAt:row.created_at, snapshot, snapshotSha256:row.snapshot_sha256 };
  }
  delete(executionId) { const found=this.findLatest(executionId,{verify:false}); if(!found)return false; this.db.run(`DELETE FROM checkpoints WHERE execution_id=${SqliteDatabase.literal(executionId)};`); return true; }
  clear() { this.db.run('DELETE FROM checkpoints;'); }
  count() { return this.db.query('SELECT COUNT(*) AS count FROM checkpoints;')[0].count; }
}

class SqliteApprovalRepository {
  constructor(db) { this.db = db; }
  save(approval) {
    this.db.run(`INSERT INTO approvals(approval_id,execution_id,step,plan_revision,tool,capability,scope,issued_at,expires_at,used,used_at,metadata) VALUES (${SqliteDatabase.literal(approval.approvalId)},${SqliteDatabase.literal(approval.executionId)},${approval.step},${approval.planRevision},${SqliteDatabase.literal(approval.tool)},${SqliteDatabase.literal(approval.capability)},${SqliteDatabase.json(approval.scope)},${SqliteDatabase.literal(approval.issuedAt)},${SqliteDatabase.literal(approval.expiresAt)},${approval.used ? 1 : 0},${SqliteDatabase.literal(approval.usedAt || null)},${SqliteDatabase.json(approval.metadata)});`);
    return { ...approval };
  }
  findById(approvalId) {
    const rows=this.db.query(`SELECT * FROM approvals WHERE approval_id=${SqliteDatabase.literal(approvalId)} LIMIT 1;`);
    if(!rows.length)return null;
    const r=rows[0];
    return { approvalId:r.approval_id,executionId:r.execution_id,step:Number(r.step),planRevision:Number(r.plan_revision),tool:r.tool,capability:r.capability,scope:JSON.parse(r.scope),issuedAt:r.issued_at,expiresAt:r.expires_at,used:Boolean(r.used),usedAt:r.used_at||undefined,metadata:JSON.parse(r.metadata) };
  }
  consume(approvalId, usedAt) {
    const changed=this.db.query(`SELECT approval_id FROM approvals WHERE approval_id=${SqliteDatabase.literal(approvalId)} AND used=0 LIMIT 1;`).length;
    if(!changed)return false;
    this.db.run(`UPDATE approvals SET used=1,used_at=${SqliteDatabase.literal(usedAt)} WHERE approval_id=${SqliteDatabase.literal(approvalId)} AND used=0;`);
    return true;
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
  }
}

module.exports = SqlitePersistence;
