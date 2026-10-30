'use strict';

const { normalizeMemory } = require('../../../domain/memory/memory.entity');

class SqliteMemoryRepository {
  constructor(db) {
    if (!db || typeof db.run !== 'function' || typeof db.query !== 'function') {
      throw new TypeError('SQLite database adapter is required');
    }
    this.db = db;
  }

  findAll(tenantId = 'local', scope = null) {
    const params = [tenantId || 'local'];
    let where = 'tenant_id = ?';
    if (scope) { where += ' AND scope = ?'; params.push(scope); }
    return this.db.query(
      `SELECT payload FROM memories WHERE ${where} ORDER BY created_at DESC, memory_id DESC`,
      params
    ).map(row => JSON.parse(row.payload));
  }

  findById(id, tenantId = 'local', scope = null) {
    if (!id) return null;
    const params = [tenantId || 'local', id];
    let where = 'tenant_id = ? AND memory_id = ?';
    if (scope) { where += ' AND scope = ?'; params.push(scope); }
    const rows = this.db.query(`SELECT payload FROM memories WHERE ${where} LIMIT 1`, params);
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }

  findByFingerprint({ tenantId = 'local', scope = null, type, text }) {
    const params = [tenantId || 'local', type, String(text || '').trim()];
    let scopeClause = '';
    if (scope) { scopeClause = ' AND scope = ?'; params.push(scope); }
    const rows = this.db.query(
      `SELECT payload FROM memories WHERE tenant_id = ? AND json_extract(payload, '$.type') = ?
       AND lower(trim(json_extract(payload, '$.text'))) = lower(trim(?))
       AND json_extract(payload, '$.state') != 'archived'${scopeClause}
       ORDER BY created_at DESC LIMIT 1`,
      params
    );
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }

  findActiveBySemanticKey(key, tenantId = 'local', scope = null) {
    if (!key) return null;
    const params = [tenantId || 'local', key];
    let scopeClause = '';
    if (scope) { scopeClause = ' AND scope = ?'; params.push(scope); }
    const rows = this.db.query(
      `SELECT payload FROM memories WHERE tenant_id = ?
       AND json_extract(payload, '$.semanticKey') = ?
       AND json_extract(payload, '$.state') = 'active'${scopeClause}
       ORDER BY updated_at DESC LIMIT 1`,
      params
    );
    return rows.length ? JSON.parse(rows[0].payload) : null;
  }

  insert(memory) {
    const item = normalizeMemory(memory);
    this.db.run(
      'INSERT INTO memories(memory_id, tenant_id, scope, created_at, updated_at, payload) VALUES(?,?,?,?,?,?)',
      [item.id, item.tenantId, item.scope, item.createdAt, item.updatedAt, JSON.stringify(item)]
    );
    return item;
  }

  update(id, patch, tenantId = 'local', scope = null) {
    const current = this.findById(id, tenantId, scope);
    if (!current) return null;
    const updated = normalizeMemory({
      ...current, ...patch, id: current.id,
      tenantId: current.tenantId, scope: current.scope
    });
    const effectiveTenantId = current.tenantId || tenantId || 'local';
    const result = this.db.run(
      'UPDATE memories SET updated_at = ?, payload = ? WHERE tenant_id = ? AND memory_id = ? AND scope = ?',
      [updated.updatedAt, JSON.stringify(updated), effectiveTenantId, id, current.scope]
    );
    return result.changes === 1 ? updated : null;
  }

  deleteById(id, tenantId = 'local', scope = null) {
    const params = [tenantId || 'local', id];
    let where = 'tenant_id = ? AND memory_id = ?';
    if (scope) { where += ' AND scope = ?'; params.push(scope); }
    return this.db.run(`DELETE FROM memories WHERE ${where}`, params).changes === 1;
  }
}

class SqliteMemoryAuditRepository {
  constructor(db) {
    if (!db || typeof db.run !== 'function' || typeof db.query !== 'function') {
      throw new TypeError('SQLite database adapter is required');
    }
    this.db = db;
  }

  append(event) {
    const record = {
      ...event,
      id: event.id || require('node:crypto').randomUUID(),
      occurredAt: event.occurredAt || new Date().toISOString()
    };
    this.db.run(
      'INSERT INTO memory_audit(event_id, tenant_id, scope, memory_id, operation_id, occurred_at, payload) VALUES(?,?,?,?,?,?,?)',
      [record.id, record.tenantId || 'local', record.scope || 'personal',
        record.memoryId || null, record.operationId || null,
        record.occurredAt, JSON.stringify(record)]
    );
    return record;
  }

  findByMemoryId(id, tenantId = 'local', scope = null) {
    const params = [tenantId, id];
    let where = 'tenant_id = ? AND memory_id = ?';
    if (scope) { where += ' AND scope = ?'; params.push(scope); }
    return this.db.query(
      `SELECT payload FROM memory_audit WHERE ${where} ORDER BY occurred_at, event_id`,
      params
    ).map(row => JSON.parse(row.payload));
  }

  findByOperationId(id, tenantId = 'local', scope = null) {
    const params = [tenantId, id];
    let where = 'tenant_id = ? AND operation_id = ?';
    if (scope) { where += ' AND scope = ?'; params.push(scope); }
    return this.db.query(
      `SELECT payload FROM memory_audit WHERE ${where} ORDER BY occurred_at, event_id`,
      params
    ).map(row => JSON.parse(row.payload));
  }
}

module.exports = { SqliteMemoryRepository, SqliteMemoryAuditRepository };
