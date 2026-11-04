'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const assertMemoryPersistenceMode = require('../../src/application/memory/assert-memory-persistence-mode');

test('JSON and SQLite memory modes remain supported', () => {
  assert.equal(assertMemoryPersistenceMode('json'), undefined);
  assert.equal(assertMemoryPersistenceMode('sqlite'), undefined);
});

test('PostgreSQL memory mode is accepted only through the async service boundary', () => {
  assert.equal(assertMemoryPersistenceMode('postgres'), undefined);
});

test('unknown memory persistence modes are rejected explicitly', () => {
  assert.throws(
    () => assertMemoryPersistenceMode('mysql'),
    error => error.code === 'MEMORY_PERSISTENCE_MODE_UNSUPPORTED'
  );
});

const { PostgresMemoryAuditRepository } = require('../../src/infrastructure/persistence/postgres/memory.repository');

test('PostgreSQL audit repository publishes only after durable insert succeeds', async () => {
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rowCount: 1, rows: [] };
    }
  };
  const repository = new PostgresMemoryAuditRepository(db);
  const published = [];
  repository.setEventSink(event => published.push(event));

  const record = await repository.append({
    action: 'memory.created',
    tenantId: 'tenant-a',
    scope: 'personal',
    memoryId: 'memory-a'
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO memory_audit/);
  assert.equal(published.length, 1);
  assert.equal(published[0].id, record.id);
  assert.equal(repository.lastEventSinkError, null);
});

test('PostgreSQL audit observation failure does not fail a committed append', async () => {
  const repository = new PostgresMemoryAuditRepository({
    async query() { return { rowCount: 1, rows: [] }; }
  });
  repository.setEventSink(async () => {
    throw Object.assign(new Error('observation unavailable'), { code: 'OBSERVATION_DOWN' });
  });

  const record = await repository.append({
    action: 'memory.created',
    tenantId: 'tenant-a',
    scope: 'personal',
    memoryId: 'memory-a'
  });

  assert.equal(record.action, 'memory.created');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(repository.lastEventSinkError.code, 'OBSERVATION_DOWN');
});

const SqlitePersistence = require('../../src/infrastructure/persistence/sqlite/sqlite-persistence');

test('SQLite audit observation failure captures async rejection after durable commit', async () => {
  const persistence = new SqlitePersistence({ filePath: ':memory:' });
  try {
    persistence.memoryAudit.setEventSink(async () => {
      throw Object.assign(new Error('observation unavailable'), { code: 'OBSERVATION_DOWN' });
    });

    await persistence.db.transactionAsync(async () => {
      persistence.memoryAudit.append({
        id: 'sqlite-audit-observation-failure',
        action: 'memory.created',
        tenantId: 'tenant-a',
        scope: 'personal',
        memoryId: 'memory-a'
      });
    });

    assert.equal(
      persistence.memoryAudit.findByMemoryId('memory-a', 'tenant-a', 'personal').length,
      1,
      'the durable audit receipt must remain committed'
    );
    assert.equal(persistence.memoryAudit.lastEventSinkError.code, 'OBSERVATION_DOWN');
  } finally {
    persistence.close();
  }
});
