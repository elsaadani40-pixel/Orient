'use strict';

const crypto = require('node:crypto');
const { validateAcknowledgement, prepareAcknowledgement } = require('../workflow-outbox-utils');

class SqliteWorkflowRepository {
  constructor(db) { this.db = db; }

  save(instance, tenantId = null, { workerPrincipal = null } = {}) {
    if (workerPrincipal) {
      throw Object.assign(new Error('SQLite persistence cannot verify worker sessions and lease fencing for workflow writes'), {
        code: 'WORKER_DURABLE_FENCING_UNSUPPORTED', status: 503
      });
    }
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


  repair(instance, { tenantId = null, expectedRevision = 0, targetRevision } = {}) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenantId = item.tenantId || 'local';
    if (tenantId && effectiveTenantId !== tenantId) throw new Error('Workflow tenant mismatch');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 ||
        !Number.isInteger(targetRevision) || targetRevision < expectedRevision) {
      throw Object.assign(new Error('Invalid workflow repair revision'), { code: 'WORKFLOW_REPAIR_REVISION_INVALID' });
    }
    const existing = this.findById(item.workflowId);
    if (existing && (existing.tenantId || 'local') !== effectiveTenantId) {
      throw Object.assign(new Error('Workflow snapshot changed during repair'), { code: 'WORKFLOW_CHECKPOINT_CONFLICT' });
    }
    const currentRevision = Number(existing?.checkpoint?.revision || 0);
    const expectedLastSavedAt = item.checkpoint?.lastSavedAt || null;
    const currentLastSavedAt = existing?.checkpoint?.lastSavedAt || null;
    if (currentRevision !== expectedRevision || currentLastSavedAt !== expectedLastSavedAt) {
      throw Object.assign(new Error('Stale workflow checkpoint during repair'), { code: 'WORKFLOW_CHECKPOINT_CONFLICT' });
    }
    item.checkpoint = { revision: targetRevision, lastSavedAt: new Date().toISOString() };
    if (!existing) {
      const inserted = this.db.run(
        'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workflow_id) DO NOTHING',
        [item.workflowId, effectiveTenantId, item.state, item.updatedAt || item.checkpoint.lastSavedAt, JSON.stringify(item)]
      );
      if (Number(inserted.changes) !== 1) {
        throw Object.assign(new Error('Workflow snapshot changed during repair'), { code: 'WORKFLOW_CHECKPOINT_CONFLICT' });
      }
    } else {
      const now = new Date().toISOString();
      const updated = this.db.run(
        "UPDATE workflows SET state=?,updated_at=?,payload=? WHERE workflow_id=? AND tenant_id=? AND COALESCE(CAST(json_extract(payload, '$.checkpoint.revision') AS INTEGER),0)=? AND COALESCE(json_extract(payload, '$.checkpoint.lastSavedAt'),'')=? AND NOT EXISTS (SELECT 1 FROM workflow_leases WHERE workflow_id=? AND expires_at>?)",
        [item.state, item.updatedAt || item.checkpoint.lastSavedAt, JSON.stringify(item),
          item.workflowId, effectiveTenantId, expectedRevision, expectedLastSavedAt || '', item.workflowId, now]
      );
      if (Number(updated.changes) !== 1) {
        const activeLease = this.db.query(
          'SELECT 1 FROM workflow_leases WHERE workflow_id=? AND expires_at>? LIMIT 1',
          [item.workflowId, now]
        );
        if (activeLease.length) {
          throw Object.assign(new Error('Workflow repair rejected while a worker lease is active'), { code: 'WORKFLOW_LEASE_HELD' });
        }
        throw Object.assign(new Error('Workflow checkpoint changed during repair'), { code: 'WORKFLOW_CHECKPOINT_CONFLICT' });
      }
    }
    if (typeof instance?.setCheckpointRevision === 'function') {
      instance.setCheckpointRevision(targetRevision, item.checkpoint.lastSavedAt);
    }
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
    const tenantClause = tenantId ? ' AND tenant_id=?' : '';
    const values = tenantId ? [String(executionId), tenantId] : [String(executionId)];
    const rows = this.db.query(
      'SELECT payload FROM workflows WHERE json_extract(payload, \'$.metadata.approvalBlocked\')=1' +
      ' AND json_extract(payload, \'$.metadata.approvalExecutionId\')=?' +
      tenantClause + ' ORDER BY updated_at DESC LIMIT 1;',
      values
    );
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }

  findPendingPublications({ tenantId = null, limit = 100 } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 100;
    const clauses = [
      "json_extract(payload, '$.metadata.approvalBlocked') = 1",
      "CASE WHEN json_type(payload, '$.metadata.pendingPublications') = 'array' " +
        "THEN json_array_length(payload, '$.metadata.pendingPublications') ELSE 0 END > 0"
    ];
    const params = [];
    if (tenantId) { clauses.push('tenant_id = ?'); params.push(tenantId); }
    params.push(boundedLimit);
    const rows = this.db.query(
      'SELECT payload FROM workflows WHERE ' + clauses.join(' AND ') + ' ORDER BY updated_at ASC LIMIT ?',
      params
    );
    return rows.map(row => JSON.parse(row.payload));
  }

  acknowledgePendingPublications(workflowId, tenantId, eventIds = []) {
    const acknowledgedIds = validateAcknowledgement(workflowId, tenantId, eventIds);
    const row = this.db.query(
      'SELECT payload FROM workflows WHERE workflow_id=? AND tenant_id=? LIMIT 1',
      [workflowId, tenantId]
    )[0];
    if (!row) {
      throw Object.assign(new Error('Workflow not found for outbox acknowledgement'), { code: 'WORKFLOW_NOT_FOUND' });
    }
    const { updated, receipt } = prepareAcknowledgement(JSON.parse(row.payload), acknowledgedIds);
    if (!updated) return receipt;
    const lastSavedAt = receipt.lastSavedAt;
    const result = this.db.run(
      'UPDATE workflows SET payload=?,updated_at=? WHERE workflow_id=? AND tenant_id=? AND payload=?',
      [JSON.stringify(updated), lastSavedAt, workflowId, tenantId, row.payload]
    );
    if (Number(result.changes) !== 1) {
      throw Object.assign(new Error('Workflow outbox acknowledgement raced with another writer'), {
        code: 'WORKFLOW_OUTBOX_ACK_CONFLICT'
      });
    }
    return receipt;
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
