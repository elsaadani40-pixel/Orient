const crypto = require('crypto');

class SqliteWorkflowRepository {
  constructor(db) { this.db = db; }

  save(instance, tenantId = null) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenantId = item.tenantId || 'local';
    if (tenantId && effectiveTenantId !== tenantId) throw new Error('Workflow tenant mismatch');
    const existing = this.findById(item.workflowId);
    if (existing && (existing.tenantId || 'local') !== effectiveTenantId) throw new Error('Workflow tenant collision');
    this.db.run('INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES (' +
      this.db.constructor.literal(item.workflowId) + ',' + this.db.constructor.literal(item.tenantId || 'local') + ',' +
      this.db.constructor.literal(item.state) + ',' + this.db.constructor.literal(item.updatedAt || new Date().toISOString()) + ',' +
      this.db.constructor.json(item) + ') ON CONFLICT(workflow_id) DO UPDATE SET tenant_id=excluded.tenant_id,state=excluded.state,updated_at=excluded.updated_at,payload=excluded.payload;');
    return item;
  }

  findById(workflowId, tenantId = null) {
    const tenantClause = tenantId ? ' AND tenant_id=' + this.db.constructor.literal(tenantId) : '';
    const rows = this.db.query('SELECT payload FROM workflows WHERE workflow_id=' + this.db.constructor.literal(workflowId) + tenantClause + ' LIMIT 1;');
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }

  findAll({ tenantId = null } = {}) {
    const tenantClause = tenantId ? ' WHERE tenant_id=' + this.db.constructor.literal(tenantId) : '';
    return this.db.query('SELECT payload FROM workflows' + tenantClause + ' ORDER BY updated_at DESC;').map(row => JSON.parse(row.payload));
  }

  delete(workflowId, tenantId = null) {
    const found = this.findById(workflowId, tenantId);
    if (!found) return false;
    const tenantClause = tenantId ? ' AND tenant_id=' + this.db.constructor.literal(tenantId) : '';
    this.db.run('DELETE FROM workflows WHERE workflow_id=' + this.db.constructor.literal(workflowId) + tenantClause + ';');
    return true;
  }

  count() {
    return Number(this.db.query('SELECT COUNT(*) AS count FROM workflows;')[0].count);
  }
}

class SqliteWorkflowLeaseRepository {
  constructor(db) { this.db = db; }

  tryAcquire(lease, tenantId = null) {
    if (tenantId && lease.metadata?.tenantId !== tenantId) return null;
    const workflowId = this.db.constructor.literal(lease.workflowId);
    const expiresAt = this.db.constructor.literal(new Date(lease.expiresAt).toISOString());
    const leaseId = this.db.constructor.literal(lease.leaseId);
    const workerId = this.db.constructor.literal(lease.workerId);
    const acquiredAt = this.db.constructor.literal(new Date(lease.acquiredAt).toISOString());
    const payload = this.db.constructor.json(lease);

    // BEGIN IMMEDIATE serializes competing writers. Expired ownership is
    // removed and the new lease is inserted in the same transaction.
    this.db.transaction([
      `DELETE FROM workflow_leases
       WHERE workflow_id=${workflowId}
         AND expires_at <= ${acquiredAt};`,
      `INSERT OR IGNORE INTO workflow_leases(
         workflow_id, lease_id, worker_id, acquired_at, expires_at, payload
       ) VALUES (
         ${workflowId}, ${leaseId}, ${workerId}, ${acquiredAt}, ${expiresAt}, ${payload}
       );`
    ]);

    const current = this.findByWorkflowId(lease.workflowId, tenantId);
    return current && current.leaseId === lease.leaseId ? { ...lease } : null;
  }

  save(lease, tenantId = null) {
    if (tenantId && lease.metadata?.tenantId !== tenantId) throw new Error('Lease tenant mismatch');
    this.db.run('INSERT INTO workflow_leases(workflow_id,lease_id,worker_id,acquired_at,expires_at,payload) VALUES (' +
      this.db.constructor.literal(lease.workflowId) + ',' + this.db.constructor.literal(lease.leaseId) + ',' +
      this.db.constructor.literal(lease.workerId) + ',' + this.db.constructor.literal(new Date(lease.acquiredAt).toISOString()) + ',' +
      this.db.constructor.literal(new Date(lease.expiresAt).toISOString()) + ',' + this.db.constructor.json(lease) +
      ') ON CONFLICT(workflow_id) DO UPDATE SET lease_id=excluded.lease_id,worker_id=excluded.worker_id,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at,payload=excluded.payload;');
    return { ...lease };
  }

  renewIfOwned(workflowId, leaseId, expiresAt, now = Date.now(), tenantId = null) {
    const current = this.findByWorkflowId(workflowId, tenantId);
    if (!current || current.leaseId !== leaseId) return false;
    const nowIso = new Date(now).toISOString();

    const renewed = {
      ...current,
      expiresAt
    };

    const result = this.db.query(
      'UPDATE workflow_leases SET expires_at=' +
      this.db.constructor.literal(new Date(expiresAt).toISOString()) +
      ', payload=' + this.db.constructor.json(renewed) +
      ' WHERE workflow_id=' + this.db.constructor.literal(workflowId) +
      ' AND lease_id=' + this.db.constructor.literal(leaseId) +
      ' AND expires_at > ' + this.db.constructor.literal(nowIso) +
      '; SELECT changes() AS changes;'
    );
    return Boolean(result.length && Number(result[result.length - 1].changes) === 1);
  }

  findByWorkflowId(workflowId, tenantId = null) {
    const rows = this.db.query('SELECT payload FROM workflow_leases WHERE workflow_id=' + this.db.constructor.literal(workflowId) + ' LIMIT 1;');
    if (!rows.length) return null;
    const payload = JSON.parse(rows[0].payload);
    return tenantId && payload.metadata?.tenantId !== tenantId ? null : payload;
  }

  findAll({ tenantId = null } = {}) {
    return this.db.query('SELECT payload FROM workflow_leases ORDER BY acquired_at ASC;')
      .map(row => JSON.parse(row.payload))
      .filter(payload => !tenantId || payload.metadata?.tenantId === tenantId);
  }

  delete(workflowId, leaseId, tenantId = null) {
    const current = this.findByWorkflowId(workflowId, tenantId);
    if (!current || current.leaseId !== leaseId) return false;
    const result = this.db.query('DELETE FROM workflow_leases WHERE workflow_id=' + this.db.constructor.literal(workflowId) + ' AND lease_id=' + this.db.constructor.literal(leaseId) + '; SELECT changes() AS changes;');
    return Boolean(result.length && Number(result[result.length - 1].changes) === 1);
  }

  deleteExpired(workflowId, leaseId, now = Date.now(), tenantId = null) {
    const current = this.findByWorkflowId(workflowId, tenantId);
    if (!current || current.leaseId !== leaseId) return false;
    const result = this.db.query(
      'DELETE FROM workflow_leases WHERE workflow_id=' +
      this.db.constructor.literal(workflowId) +
      ' AND lease_id=' + this.db.constructor.literal(leaseId) +
      ' AND expires_at <= ' +
      this.db.constructor.literal(new Date(now).toISOString()) +
      '; SELECT changes() AS changes;'
    );
    return Boolean(
      result.length &&
      Number(result[result.length - 1].changes) === 1
    );
  }

  count() {
    return Number(this.db.query('SELECT COUNT(*) AS count FROM workflow_leases;')[0].count);
  }
}

module.exports = { SqliteWorkflowRepository, SqliteWorkflowLeaseRepository };
