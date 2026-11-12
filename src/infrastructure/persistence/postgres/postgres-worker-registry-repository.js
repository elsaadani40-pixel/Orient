const AppError = require('../../../core/errors/AppError');
const { assertWorkerPersistencePrincipal } = require('../../../core/security/worker-persistence-principal');

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
      sessionId: worker.sessionId || null,
      startedAt: worker.startedAt || new Date().toISOString(),
      heartbeatAt: worker.heartbeatAt || new Date().toISOString(),
      expiresAt: worker.expiresAt || new Date(Date.now() + 30000).toISOString(),
      status: worker.status || 'READY',
      capabilities: Array.isArray(worker.capabilities) ? worker.capabilities : [],
      metadata: { ...(worker.metadata || {}), tenantId: tenant }
    };
  }

  assertPrincipal(workerPrincipal, tenantId, workerId = null, capabilities = null) {
    const principal = assertWorkerPersistencePrincipal(workerPrincipal);
    if (principal.tenantId !== tenantOrLocal(tenantId) ||
        (workerId && principal.workerId !== workerId)) {
      throw new AppError('Worker persistence principal does not match this operation', 403, 'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH');
    }
    if (capabilities) {
      const authority = new Set(principal.capabilities);
      if (capabilities.some(capability => !authority.has(capability))) {
        throw new AppError('Worker capabilities exceed the trusted principal', 403, 'WORKER_CAPABILITY_MISMATCH');
      }
    }
    if (typeof this.db.transactionWithWorkerPrincipal !== 'function') {
      throw new AppError('Worker-scoped PostgreSQL transactions are required', 503, 'WORKER_PRINCIPAL_TRANSACTION_REQUIRED');
    }
    return principal;
  }

  async register(worker, tenantId = null, { workerPrincipal = null } = {}) {
    const item = this.normalize(worker, tenantId);
    const principal = this.assertPrincipal(workerPrincipal, item.tenantId, item.workerId, item.capabilities);
    item.sessionId = principal.sessionId;
    item.metadata = { ...item.metadata, workerSessionId: principal.sessionId };
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      const result = await client.query(
        `INSERT INTO worker_nodes(tenant_id,worker_id,started_at,heartbeat_at,expires_at,status,capabilities,metadata,session_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(tenant_id,worker_id) DO UPDATE SET
           started_at=EXCLUDED.started_at,
           heartbeat_at=EXCLUDED.heartbeat_at,
           expires_at=EXCLUDED.expires_at,
           status=EXCLUDED.status,
           capabilities=EXCLUDED.capabilities,
           metadata=EXCLUDED.metadata,
           session_id=EXCLUDED.session_id
         WHERE worker_nodes.expires_at <= clock_timestamp() OR worker_nodes.session_id=EXCLUDED.session_id
         RETURNING *`,
        [item.tenantId,item.workerId,item.startedAt,item.heartbeatAt,item.expiresAt,item.status,JSON.stringify(item.capabilities),item.metadata,item.sessionId]
      );
      if (result.rowCount !== 1) {
        throw new AppError('A different active worker session already owns this worker ID', 409, 'WORKER_SESSION_CONFLICT');
      }
      return this.row(result.rows[0]);
    });
  }

  async heartbeat(workerId, { tenantId = null, heartbeatAt = new Date().toISOString(), expiresAt, status = 'READY', workerPrincipal = null } = {}) {
    const tenant = tenantOrLocal(tenantId);
    const principal = this.assertPrincipal(workerPrincipal, tenant, workerId);
    const effectiveExpiry = expiresAt || new Date(new Date(heartbeatAt).getTime() + 30000).toISOString();
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      // Acquire the row lock before checking expiry. A volatile timestamp
      // predicate inside a single UPDATE can be evaluated before a lock wait;
      // the separate check below runs only after this transaction owns the row.
      const locked = await client.query(
        'SELECT 1 FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3 FOR UPDATE',
        [tenant,workerId,principal.sessionId]
      );
      if (locked.rowCount !== 1) {
        throw new AppError('Worker session is not active or has been replaced', 409, 'WORKER_SESSION_LOST');
      }
      const active = await client.query(
        'SELECT 1 FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3 AND expires_at > clock_timestamp()',
        [tenant,workerId,principal.sessionId]
      );
      if (active.rowCount !== 1) {
        throw new AppError('Worker session is not active or has been replaced', 409, 'WORKER_SESSION_LOST');
      }
      const result = await client.query(
        `UPDATE worker_nodes
         SET heartbeat_at=GREATEST(heartbeat_at,$1),expires_at=GREATEST(expires_at,$2),status=$3
         WHERE tenant_id=$4 AND worker_id=$5 AND session_id=$6 AND expires_at > clock_timestamp()
         RETURNING *`,
        [heartbeatAt,effectiveExpiry,status,tenant,workerId,principal.sessionId]
      );
      if (result.rowCount !== 1) {
        throw new AppError('Worker session is not active or has been replaced', 409, 'WORKER_SESSION_LOST');
      }
      return this.row(result.rows[0]);
    });
  }

  async unregister(workerId, tenantId = null, { workerPrincipal = null } = {}) {
    const tenant = tenantOrLocal(tenantId);
    const principal = this.assertPrincipal(workerPrincipal, tenant, workerId);
    return this.db.transactionWithWorkerPrincipal(principal, async client => {
      const result = await client.query(
        'DELETE FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3',
        [tenant,workerId,principal.sessionId]
      );
      return result.rowCount === 1;
    });
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
      sessionId: row.session_id || null,
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
