'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SqlitePersistence = require('../../../../src/infrastructure/persistence/sqlite/sqlite-persistence');
const MemoryService = require('../../../../src/application/memory/memory.service');

test('SQLite MemoryService awaits service operations inside serialized durable transactions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-memory-async-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.sqlite') });
  t.after(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const database = persistence.db;
  const coordinator = {
    runAsync: operation => database.transactionAsync(operation),
    readAsync: operation => database.readAsync(operation),
    tryReadAsync: operation => database.tryReadAsync(operation)
  };
  const service = new MemoryService(persistence.memory, {
    auditRepository: persistence.memoryAudit,
    transactionCoordinator: coordinator
  });
  const context = {
    agentId: 'ORIENT_RUNTIME',
    tenantId: 'tenant-sqlite-async',
    operationId: 'sqlite-op-' + Date.now()
  };

  const created = await service.add('SQLite asynchronous memory proof', { type: 'fact' }, context);
  assert.ok(created.id);
  assert.equal((await service.list('asynchronous memory', context)).length, 1);
  assert.equal((await service.history(created.id, context)).some(event => event.action === 'memory.created'), true);
  assert.equal((await service.get(created.id, context)).text, created.text);
  assert.equal(await service.count(context), 1);

  const restarted = new MemoryService(persistence.memory, {
    auditRepository: persistence.memoryAudit,
    transactionCoordinator: coordinator
  });
  assert.equal((await restarted.list('', context)).length, 1);
  assert.equal(await restarted.delete(created.id, context), true);
  assert.equal((await service.list('', context)).length, 0);
});

test('SQLite async transaction rolls back awaited failures and releases the connection', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-async-rollback-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.sqlite') });
  t.after(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    () => persistence.db.transactionAsync(async db => {
      db.run(
        'INSERT INTO memories(memory_id,tenant_id,scope,created_at,updated_at,payload) VALUES(?,?,?,?,?,?)',
        ['rollback-memory', 'tenant-a', 'personal', new Date().toISOString(), new Date().toISOString(), JSON.stringify({ id: 'rollback-memory' })]
      );
      await Promise.resolve();
      throw new Error('injected async transaction failure');
    }),
    /injected async transaction failure/
  );

  assert.equal(persistence.memory.findById('rollback-memory', 'tenant-a', 'personal'), null);
  await persistence.db.transactionAsync(async db => {
    db.run(
      'INSERT INTO memories(memory_id,tenant_id,scope,created_at,updated_at,payload) VALUES(?,?,?,?,?,?)',
      ['after-rollback', 'tenant-a', 'personal', new Date().toISOString(), new Date().toISOString(), JSON.stringify({ id: 'after-rollback' })]
    );
  });
  assert.ok(persistence.memory.findById('after-rollback', 'tenant-a', 'personal'));
});
