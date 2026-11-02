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


test('SQLite reconciliation reads fail fast while an async transaction owns the connection', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-try-read-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.sqlite') });
  t.after(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let release;
  const blocker = persistence.db.transactionAsync(async () => {
    await new Promise(resolve => { release = resolve; });
  });
  await Promise.resolve();

  const snapshot = await persistence.db.tryReadAsync(async () => 'must not run');
  assert.deepEqual(snapshot, { acquired: false });

  release();
  await blocker;
  assert.deepEqual(
    await persistence.db.tryReadAsync(async () => 'available'),
    { acquired: true, value: 'available' }
  );
});

test('SQLite async transactions reject unrelated synchronous writes instead of absorbing them', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-async-isolation-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.sqlite') });
  t.after(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const transaction = persistence.db.transactionAsync(async db => {
    db.run(
      'INSERT INTO memories(memory_id,tenant_id,scope,created_at,updated_at,payload) VALUES(?,?,?,?,?,?)',
      ['isolated-memory', 'tenant-a', 'personal', new Date().toISOString(), new Date().toISOString(), JSON.stringify({ id: 'isolated-memory' })]
    );
    entered();
    await new Promise(resolve => { release = resolve; });
    throw new Error('rollback isolated transaction');
  });

  await started;
  // WAL readers may inspect the last committed snapshot, but must not see
  // the uncommitted memory row owned by the isolated transaction.
  assert.equal(
    persistence.db.query('SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?', ['isolated-memory'])[0].count,
    0
  );
  assert.throws(
    () => persistence.db.run(
      'INSERT INTO events(event_id,type,timestamp,payload) VALUES(?,?,?,?)',
      ['unrelated-event', 'test', new Date().toISOString(), '{}']
    ),
    error => error.code === 'SQLITE_TRANSACTION_BUSY'
  );

  release();
  await assert.rejects(transaction, /rollback isolated transaction/);
  assert.equal(persistence.db.query('SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?', ['isolated-memory'])[0].count, 0);
  assert.equal(persistence.db.query('SELECT COUNT(*) AS count FROM events WHERE event_id = ?', ['unrelated-event'])[0].count, 0);
});


test('SQLite memory operation receipts reconcile after closing and reopening the database', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-memory-restart-'));
  const filePath = path.join(directory, 'orient.sqlite');
  let firstPersistence = new SqlitePersistence({ filePath });
  t.after(() => {
    try { firstPersistence?.close(); } catch {}
    try { secondPersistence?.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const coordinatorFor = persistence => ({
    runAsync: operation => persistence.db.transactionAsync(operation),
    readAsync: operation => persistence.db.readAsync(operation),
    tryReadAsync: operation => persistence.db.tryReadAsync(operation)
  });
  const context = {
    tenantId: 'tenant-restart',
    memoryScope: 'personal',
    operationId: 'sqlite-operation-restart'
  };
  const firstService = new MemoryService(firstPersistence.memory, {
    auditRepository: firstPersistence.memoryAudit,
    transactionCoordinator: coordinatorFor(firstPersistence)
  });
  const created = await firstService.add('durable SQLite operation receipt', {}, context);
  firstPersistence.close();
  firstPersistence = null;

  let secondPersistence = new SqlitePersistence({ filePath });
  const secondService = new MemoryService(secondPersistence.memory, {
    auditRepository: secondPersistence.memoryAudit,
    transactionCoordinator: coordinatorFor(secondPersistence)
  });

  const reconciled = await secondService.reconcileToolOperation('memory.add', {
    text: 'durable SQLite operation receipt'
  }, context);
  assert.equal(reconciled.status, 'completed');
  assert.equal(reconciled.result.id, created.id);
  assert.equal(
    (await secondService.reconcileToolOperation('memory.add', {
      text: 'durable SQLite operation receipt'
    }, { ...context, tenantId: 'tenant-other' })).status,
    'unknown',
    'a receipt must never cross tenant boundaries after restart'
  );
});
