'use strict';

const crypto = require('node:crypto');

class SqliteWorkflowRepository {
  constructor(db) { this.db = db; }

  save(instance, tenantId = null) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenantId = item.tenantId || 'local';
    if (tenantId && effectiveTenantId !== tenantId) throw new Error('Workflow tenant mismatch');
    const existing = this.findById(item.workflowId);
    if (existing && (existing.tenantId || 'local') !== effectiveTenantId) throw new Error('Workflow tenant collision');
    this.db.run(
      'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(workflow_id) DO UPDATE SET tenant_id=excluded.tenant_id,state=excluded.state,updated_at=excluded.updated_at,payload=excluded.payload',
      [item.workflowId, effectiveTenantId, item.state, item.updatedAt || new Date().toISOString(), JSON.stringify(item)]
    );
    return item;
  }

  findById(workflowId, tenantId = null) {
    const sql = 'SELECT payload FROM workflows WHERE workflow_id = ?' + (tenantId ? ' AND tenant_id = ?' : '') + ' LIMIT 1';
    const params = tenantId ? [workflowId, tenantId] : [workflowId];
    const rows = this.db.query(sql, params);
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }

  findByApprovalExecutionId({ executionId, tenantId = null } = {}) {
    if (!executionId) return null;
    const tenantClause = tenantId ? ' AND tenant_id=' + this.db.constructor.literal(tenantId) : '';
    const rows = this.db.query(
      'SELECT payload FROM workflows WHERE json_extract(payload, \'$.metadata.approvalBlocked\')=1' +
      ' AND json_extract(payload, \'$.metadata.approvalExecutionId\')=' + this.db.constructor.literal(String(executionId)) +
      tenantClause + ' ORDER BY updated_at DESC LIMIT 1;'
    );
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }

  findAll({ tenantId = null } = {}) {
    const sql = 'SELECT payload FROM workflows' + (tenantId ? ' WHERE tenant_id = ?' : '') + ' ORDER BY updated_at DESC';
    return this.db.query(sql, tenantId ? [tenantId] : []).map(row => JSON.parse(row.payload));
  }

  delete(workflowId, tenantId = null) {
    const found = this.findById(workflowId, tenantId);
    if (!found) return false;
    this.db.run('DELETE FROM workflows WHERE workflow_id = ?' + (tenantId ? ' AND tenant_id = ?' : ''), tenantId ? [workflowId, tenantId] : [workflowId]);
    return true;
  }

  count() {
    return Number(this.db.query('SELECT COUNT(*) AS count FROM workflows')[0].count);
  }
}

class SqliteWorkflowLeaseRepository {
  constructor(db) { this.db = db; }

  tryAcquire(lease, tenantId = null) {
    if (tenantId && lease.metadata?.tenantId !== tenantId) return null;
    const acquiredAt = new Date(lease.acquiredAt).toISOString();
    const expiresAt = new Date(lease.expiresAt).toISOString();
    const deleteTenantClause = tenantId ? " AND json_extract(payload, '$.metadata.tenantId') = ?" : '';
    const deleteParams = [lease.workflowId, acquiredAt];
    if (tenantId) deleteParams.push(tenantId);
    this.db.transaction([
      {
        sql: 'DELETE FROM workflow_leases WHERE workflow_id = ? AND expires_at <= ?' + deleteTenantClause,
        params: deleteParams
      },
      {
        sql: 'INSERT OR IGNORE INTO workflow_leases(workflow_id, lease_id, worker_id, acquired_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
        params: [lease.workflowId, lease.leaseId, lease.workerId, acquiredAt, expiresAt, JSON.stringify(lease)]
      }
    ]);

    const current = this.findByWorkflowId(lease.workflowId, tenantId);
    return current && current.leaseId === lease.leaseId ? { ...lease } : null;
  }

  save(lease, tenantId = null) {
    if (tenantId && lease.metadata?.tenantId !== tenantId) throw new Error('Lease tenant mismatch');
    const existing = this.findByWorkflowId(lease.workflowId);
    if (existing && existing.leaseId !== lease.leaseId && existing.metadata?.tenantId !== lease.metadata?.tenantId) throw new Error('Lease tenant collision');
    this.db.run(
      'INSERT INTO workflow_leases(workflow_id,lease_id,worker_id,acquired_at,expires_at,payload) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(workflow_id) DO UPDATE SET lease_id=excluded.lease_id,worker_id=excluded.worker_id,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at,payload=excluded.payload',
      [lease.workflowId, lease.leaseId, lease.workerId, new Date(lease.acquiredAt).toISOString(), new Date(lease.expiresAt).toISOString(), JSON.stringify(lease)]
    );
    return { ...lease };
  }

  renewIfOwned(workflowId, leaseId, expiresAt, now = Date.now(), tenantId = null) {
    const current = this.findByWorkflowId(workflowId, tenantId);
    if (!current || current.leaseId !== leaseId) return false;
    const renewed = { ...current, expiresAt };
    const result = this.db.run(
      'UPDATE workflow_leases SET expires_at = ?, payload = ? WHERE workflow_id = ? AND lease_id = ? AND expires_at > ?',
      [new Date(expiresAt).toISOString(), JSON.stringify(renewed), workflowId, leaseId, new Date(now).toISOString()]
    );
    return Number(result.changes) === 1;
  }

  findByWorkflowId(workflowId, tenantId = null) {
    const rows = this.db.query('SELECT payload FROM workflow_leases WHERE workflow_id = ? LIMIT 1', [workflowId]);
    if (!rows.length) return null;
    const payload = JSON.parse(rows[0].payload);
    return tenantId && payload.metadata?.tenantId !== tenantId ? null : payload;
  }

  findAll({ tenantId = null } = {}) {
    return this.db.query('SELECT payload FROM workflow_leases ORDER BY acquired_at ASC')
      .map(row => JSON.parse(row.payload))
      .filter(payload => !tenantId || payload.metadata?.tenantId === tenantId);
  }

  delete(workflowId, leaseId, tenantId = null) {
    const current = this.findByWorkflowId(workflowId, tenantId);
    if (!current || current.leaseId !== leaseId) return false;
    const result = this.db.run('DELETE FROM workflow_leases WHERE workflow_id = ? AND lease_id = ?', [workflowId, leaseId]);
    return Number(result.changes) === 1;
  }

  deleteExpired(workflowId, leaseId, now = Date.now(), tenantId = null) {
    const current = this.findByWorkflowId(workflowId, tenantId);
    if (!current || current.leaseId !== leaseId) return false;
    const result = this.db.run(
      'DELETE FROM workflow_leases WHERE workflow_id = ? AND lease_id = ? AND expires_at <= ?',
      [workflowId, leaseId, new Date(now).toISOString()]
    );
    return Number(result.changes) === 1;
  }

  count() {
    return Number(this.db.query('SELECT COUNT(*) AS count FROM workflow_leases')[0].count);
  }
}

module.exports = { SqliteWorkflowRepository, SqliteWorkflowLeaseRepository };
