'use strict';

const crypto = require('node:crypto');
const { normalizeMemory } = require('../../../domain/memory/memory.entity');

class SqliteMemoryRepository {
  constructor(db) { this.db = db; }
  normalize(memory) {
    const item = normalizeMemory(memory);
    if (!item.text) throw new TypeError('Memory text cannot be empty');
    return item;
  }
  findAll(tenantId = 'local', scope = null) {
    if (tenantId && typeof tenantId === 'object') {
      scope = tenantId.scope || null;
      tenantId = tenantId.tenantId || 'local';
    }
    const rows = this.db.query(
      'SELECT payload FROM memories WHERE tenant_id = ? ORDER BY rowid DESC',
      [String(tenantId)]
    );
    return rows.map(row => JSON.parse(row.payload))
      .filter(item => !scope || item.scope === scope);
  }
  findById(id, tenantId = 'local', scope = null) {
    const rows = this.db.query(
      'SELECT payload FROM memories WHERE memory_id = ? AND tenant_id = ? LIMIT 1',
      [id, String(tenantId)]
    );
    if (!rows.length) return null;
    const item = JSON.parse(rows[0].payload);
    return !scope || item.scope === scope ? item : null;
  }
  findByFingerprint({ tenantId = 'local', scope = null, type, text }) {
    const value = String(text || '').trim().toLowerCase();
    return this.findAll(tenantId, scope).find(item =>
      item.state === 'active' && item.type === type &&
      item.text.trim().toLowerCase() === value
    ) || null;
  }
  findActiveBySemanticKey(semanticKey, tenantId = 'local', scope = null) {
    const key = String(semanticKey || '').trim();
    if (!key) return null;
    return this.findAll(tenantId, scope).find(item =>
      item.state === 'active' && item.semanticKey === key
    ) || null;
  }
  insert(memory) {
    const item = this.normalize(memory);
    this.db.run(
      'INSERT INTO memories(memory_id, tenant_id, scope, state, type, semantic_key, text, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [item.id, item.tenantId, item.scope, item.state, item.type, item.semanticKey, item.text, JSON.stringify(item)]
    );
    return item;
  }
  update(id, patch, tenantId = 'local', scope = null) {
    if (!patch || typeof patch !== 'object') throw new TypeError('patch must be an object');
    const current = this.findById(id, tenantId, scope);
    if (!current) return null;
    if (patch.tenantId !== undefined && String(patch.tenantId) !== current.tenantId) {
      throw Object.assign(new Error('Memory tenant is immutable'), { code: 'MEMORY_TENANT_IMMUTABLE' });
    }
    if (patch.scope !== undefined && String(patch.scope) !== current.scope) {
      throw Object.assign(new Error('Memory scope is immutable'), { code: 'MEMORY_SCOPE_IMMUTABLE' });
    }
    const item = this.normalize({
      ...current, ...patch, id: current.id, tenantId: current.tenantId,
      scope: current.scope, updatedAt: patch.updatedAt || new Date().toISOString()
    });
    const result = this.db.run(
      'UPDATE memories SET state = ?, type = ?, semantic_key = ?, text = ?, payload = ? WHERE memory_id = ? AND tenant_id = ? AND scope = ?',
      [item.state, item.type, item.semanticKey, item.text, JSON.stringify(item), id, current.tenantId, current.scope]
    );
    return Number(result.changes) === 1 ? item : null;
  }
  deleteById(id, tenantId = 'local', scope = null) {
    const current = this.findById(id, tenantId, scope);
    if (!current) return false;
    const result = this.db.run(
      'DELETE FROM memories WHERE memory_id = ? AND tenant_id = ? AND scope = ?',
      [id, current.tenantId, current.scope]
    );
    return Number(result.changes) === 1;
  }
}

class SqliteMemoryAuditRepository {
  constructor(db) { this.db = db; }
  append(event) {
    const record = {
      ...event,
      id: event.id || crypto.randomUUID(),
      occurredAt: event.occurredAt || new Date().toISOString()
    };
    this.db.run(
      'INSERT INTO memory_audit(event_id, tenant_id, scope, memory_id, operation_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [record.id, String(record.tenantId || 'local'), record.scope || null,
        record.memoryId || null, record.operationId || null, record.occurredAt, JSON.stringify(record)]
    );
    return record;
  }
  findByMemoryId(memoryId, tenantId = 'local', scope = null) {
    const rows = this.db.query(
      'SELECT payload FROM memory_audit WHERE memory_id = ? AND tenant_id = ? ORDER BY occurred_at, event_id',
      [memoryId, String(tenantId)]
    );
    return rows.map(row => JSON.parse(row.payload)).filter(event =>
      !scope || event.scope === scope || (!event.scope && scope === 'personal')
    );
  }
  findByOperationId(operationId, tenantId = 'local', scope = null) {
    if (typeof operationId !== 'string' || !operationId.trim()) {
      throw new TypeError('operationId is required');
    }
    const rows = this.db.query(
      'SELECT payload FROM memory_audit WHERE operation_id = ? AND tenant_id = ? ORDER BY occurred_at, event_id',
      [operationId, String(tenantId)]
    );
    return rows.map(row => JSON.parse(row.payload)).filter(event =>
      !scope || event.scope === scope || (!event.scope && scope === 'personal')
    );
  }
}

module.exports = { SqliteMemoryRepository, SqliteMemoryAuditRepository };
