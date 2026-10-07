const AppError = require('../../../core/errors/AppError');

function tenantOrLocal(value) {
  return value || 'local';
}

function assertTenant(actual, expected) {
  if (expected && actual !== expected) {
    throw new AppError('Worker tenant mismatch', 403, 'TENANT_PERSISTENCE_MISMATCH');
  }
}

class PostgresWorkerRegistryRepository {
  constructor(db) {
    this.db = db;
  }

  normalize(worker, tenantId = null) {
    const tenant = tenantOrLocal(worker.tenantId || tenantId);
    assertTenant(tenant, tenantId);
    if (!worker.workerId) throw new TypeError('workerId is required');
    return {
      workerId: worker.workerId,
      tenantId: tenant,
      startedAt: worker.startedAt || new Date().toISOString(),
      heartbeatAt: worker.heartbeatAt || new Date().toISOString(),
      expiresAt: worker.expiresAt || new Date(Date.now() + 30000).toISOString(),
      status: worker.status || 'READY',
      capabilities: Array.isArray(worker.capabilities) ? worker.capabilities : [],
      metadata: { ...(worker.metadata || {}), tenantId: tenant }
    };
  }

  async register(worker, tenantId = null) {
    const item = this.normalize(worker, tenantId);
    await this.db.query(
      `INSERT INTO worker_nodes(tenant_id,worker_id,started_at,heartbeat_at,expires_at,status,capabilities,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(tenant_id,worker_id) DO UPDATE SET
         started_at=EXCLUDED.started_at,
         heartbeat_at=EXCLUDED.heartbeat_at,
         expires_at=EXCLUDED.expires_at,
         status=EXCLUDED.status,
         capabilities=EXCLUDED.capabilities,
         metadata=EXCLUDED.metadata`,
      [item.tenantId,item.workerId,item.startedAt,item.heartbeatAt,item.expiresAt,item.status,item.capabilities,item.metadata]
    );
    return item;
  }

  async heartbeat(workerId, { tenantId = null, heartbeatAt = new Date().toISOString(), expiresAt, status = 'READY' } = {}) {
    const tenant = tenantOrLocal(tenantId);
    const effectiveExpiry = expiresAt || new Date(new Date(heartbeatAt).getTime() + 30000).toISOString();
    const result = await this.db.query(
      `UPDATE worker_nodes
       SET heartbeat_at=$1,expires_at=$2,status=$3
       WHERE tenant_id=$4 AND worker_id=$5`,
      [heartbeatAt,effectiveExpiry,status,tenant,workerId]
    );
    if (result.rowCount !== 1) {
      throw new AppError('Worker is not registered', 404, 'WORKER_NOT_REGISTERED');
    }
    return this.findById(workerId, tenant);
  }

  async unregister(workerId, tenantId = null) {
    const tenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      'DELETE FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2',
      [tenant,workerId]
    );
    return result.rowCount === 1;
  }

  async findById(workerId, tenantId = null) {
    const tenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      'SELECT * FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2 LIMIT 1',
      [tenant,workerId]
    );
    if (!result.rows.length) return null;
    return this.row(result.rows[0]);
  }

  async findAll({ tenantId = null, includeExpired = true } = {}) {
    const tenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      includeExpired
        ? 'SELECT * FROM worker_nodes WHERE tenant_id=$1 ORDER BY heartbeat_at DESC'
        : 'SELECT * FROM worker_nodes WHERE tenant_id=$1 AND expires_at > NOW() ORDER BY heartbeat_at DESC',
      [tenant]
    );
    return result.rows.map(row => this.row(row));
  }

  async reapExpired({ tenantId = null, now = new Date().toISOString() } = {}) {
    const tenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      'DELETE FROM worker_nodes WHERE tenant_id=$1 AND expires_at <= $2',
      [tenant,now]
    );
    return result.rowCount;
  }

  async count({ tenantId = null, activeOnly = false } = {}) {
    const tenant = tenantOrLocal(tenantId);
    const result = await this.db.query(
      activeOnly
        ? 'SELECT COUNT(*)::int AS count FROM worker_nodes WHERE tenant_id=$1 AND expires_at > NOW()'
        : 'SELECT COUNT(*)::int AS count FROM worker_nodes WHERE tenant_id=$1',
      [tenant]
    );
    return Number(result.rows[0].count);
  }

  row(row) {
    return {
      workerId: row.worker_id,
      tenantId: row.tenant_id,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      status: row.status,
      capabilities: row.capabilities || [],
      metadata: row.metadata || {}
    };
  }
}

module.exports = PostgresWorkerRegistryRepository;
