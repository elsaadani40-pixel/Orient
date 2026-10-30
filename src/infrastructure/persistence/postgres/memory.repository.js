'use strict';

const { normalizeMemory } = require('../../../domain/memory/memory.entity');

class PostgresMemoryRepository {
  constructor(db) {
    if (!db || typeof db.query !== 'function') throw new TypeError('PostgreSQL database adapter is required');
    this.db = db;
  }

  async findAll(tenantId = 'local', scope = null) {
    const result = scope
      ? await this.db.query('SELECT payload FROM memories WHERE tenant_id=$1 AND scope=$2 ORDER BY created_at DESC,memory_id DESC', [tenantId, scope])
      : await this.db.query('SELECT payload FROM memories WHERE tenant_id=$1 ORDER BY created_at DESC,memory_id DESC', [tenantId]);
    return result.rows.map(row => row.payload);
  }

  async findById(id, tenantId = 'local', scope = null) {
    if (!id) return null;
    const result = scope
      ? await this.db.query('SELECT payload FROM memories WHERE tenant_id=$1 AND memory_id=$2 AND scope=$3 LIMIT 1', [tenantId, id, scope])
      : await this.db.query('SELECT payload FROM memories WHERE tenant_id=$1 AND memory_id=$2 LIMIT 1', [tenantId, id]);
    return result.rows[0]?.payload || null;
  }

  async findByFingerprint({ tenantId = 'local', scope = null, type, text }) {
    const params = [tenantId, type, String(text || '').trim()];
    const scopeClause = scope ? ' AND scope=$4' : '';
    if (scope) params.push(scope);
    const result = await this.db.query(
      `SELECT payload FROM memories WHERE tenant_id=$1 AND payload->>'type'=$2
       AND lower(trim(payload->>'text'))=lower(trim($3))
       AND payload->>'state'<>'archived'${scopeClause}
       ORDER BY created_at DESC LIMIT 1`, params
    );
    return result.rows[0]?.payload || null;
  }

  async findActiveBySemanticKey(key, tenantId = 'local', scope = null) {
    if (!key) return null;
    const params = [tenantId, key];
    const scopeClause = scope ? ' AND scope=$3' : '';
    if (scope) params.push(scope);
    const result = await this.db.query(
      `SELECT payload FROM memories WHERE tenant_id=$1 AND payload->>'semanticKey'=$2
       AND payload->>'state'='active'${scopeClause} ORDER BY updated_at DESC LIMIT 1`, params
    );
    return result.rows[0]?.payload || null;
  }

  async insert(memory) {
    const item = normalizeMemory(memory);
    await this.db.query(
      'INSERT INTO memories(memory_id,tenant_id,scope,created_at,updated_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
      [item.id, item.tenantId, item.scope, item.createdAt, item.updatedAt, item]
    );
    return item;
  }

  async update(id, patch, tenantId = 'local', scope = null) {
    const current = await this.findById(id, tenantId, scope);
    if (!current) return null;
    const updated = normalizeMemory({
      ...current, ...patch, id: current.id,
      tenantId: current.tenantId, scope: current.scope
    });
    const result = await this.db.query(
      'UPDATE memories SET updated_at=$1,payload=$2 WHERE tenant_id=$3 AND memory_id=$4 AND scope=$5 RETURNING payload',
      [updated.updatedAt, updated, tenantId, id, current.scope]
    );
    return result.rows[0]?.payload || null;
  }

  async deleteById(id, tenantId = 'local', scope = null) {
    if (!id) return false;
    const result = scope
      ? await this.db.query('DELETE FROM memories WHERE tenant_id=$1 AND memory_id=$2 AND scope=$3', [tenantId, id, scope])
      : await this.db.query('DELETE FROM memories WHERE tenant_id=$1 AND memory_id=$2', [tenantId, id]);
    return result.rowCount === 1;
  }
}

class PostgresMemoryAuditRepository {
  constructor(db) {
    if (!db || typeof db.query !== 'function') throw new TypeError('PostgreSQL database adapter is required');
    this.db = db;
  }

  async append(event) {
    const record = {
      ...event,
      id: event.id || require('node:crypto').randomUUID(),
      occurredAt: event.occurredAt || new Date().toISOString()
    };
    await this.db.query(
      'INSERT INTO memory_audit(event_id,tenant_id,scope,memory_id,operation_id,occurred_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [record.id, record.tenantId || 'local', record.scope || 'personal',
        record.memoryId || null, record.operationId || null, record.occurredAt, record]
    );
    return record;
  }

  async findByMemoryId(id, tenantId = 'local', scope = null) {
    const result = scope
      ? await this.db.query('SELECT payload FROM memory_audit WHERE tenant_id=$1 AND memory_id=$2 AND scope=$3 ORDER BY occurred_at,event_id', [tenantId, id, scope])
      : await this.db.query('SELECT payload FROM memory_audit WHERE tenant_id=$1 AND memory_id=$2 ORDER BY occurred_at,event_id', [tenantId, id]);
    return result.rows.map(row => row.payload);
  }

  async findByOperationId(id, tenantId = 'local', scope = null) {
    const result = scope
      ? await this.db.query('SELECT payload FROM memory_audit WHERE tenant_id=$1 AND operation_id=$2 AND scope=$3 ORDER BY occurred_at,event_id', [tenantId, id, scope])
      : await this.db.query('SELECT payload FROM memory_audit WHERE tenant_id=$1 AND operation_id=$2 ORDER BY occurred_at,event_id', [tenantId, id]);
    return result.rows.map(row => row.payload);
  }
}

module.exports = { PostgresMemoryRepository, PostgresMemoryAuditRepository };
