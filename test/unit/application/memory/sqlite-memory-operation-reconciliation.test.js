'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqlitePersistence = require('../../../../src/infrastructure/persistence/sqlite/sqlite-persistence');
const MemoryService = require('../../../../src/application/memory/memory.service');

function createService(persistence) {
  return new MemoryService(persistence.memory, {
    defaultScope: 'personal',
    auditRepository: persistence.memoryAudit,
    transactionCoordinator: persistence.memoryTransactionCoordinator
  });
}

test('SQLite memory service commits memory and operation receipt atomically and reconciles after restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-memory-recovery-'));
  const filePath = path.join(directory, 'orient.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let persistence = new SqlitePersistence({ filePath });
  t.after(() => {
    if (persistence) {
      try { persistence.close(); } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let service = createService(persistence);
  let publishedEvents = 0;
  persistence.memoryAudit.setEventSink(() => { publishedEvents += 1; });
  const context = {
    tenantId: 'tenant-sqlite-a',
    memoryScope: 'personal',
    operationId: 'sqlite-add-committed'
  };

  const created = service.add('SQLite durable memory receipt', {}, context);
  assert.equal(persistence.memory.findById(created.id, 'tenant-sqlite-a', 'personal').text,
    'SQLite durable memory receipt');
  assert.equal(persistence.memoryAudit.findByOperationId(
    'sqlite-add-committed', 'tenant-sqlite-a', 'personal'
  ).length, 1);
  assert.equal(persistence.memoryAudit.findByOperationId(
    'sqlite-add-committed', 'tenant-sqlite-b', 'personal'
  ).length, 0);
  assert.equal(publishedEvents, 1, 'the committed create audit event should be published once');

  persistence.close();
  persistence = new SqlitePersistence({ filePath });
  service = createService(persistence);
  try {
    const result = service.reconcileToolOperation('memory.add', {
      text: 'SQLite durable memory receipt'
    }, context);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.id, created.id);
  } finally {
    persistence.close();
    persistence = null;
  }
});

test('SQLite memory and audit writes roll back together when the audit append fails', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-memory-rollback-'));
  const filePath = path.join(directory, 'orient.db');
  const persistence = new SqlitePersistence({ filePath });
  t.after(() => {
    try { persistence.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const service = createService(persistence);
  let publishedEvents = 0;
  persistence.memoryAudit.setEventSink(() => { publishedEvents += 1; });
  const originalAppend = persistence.memoryAudit.append.bind(persistence.memoryAudit);
  persistence.memoryAudit.append = () => {
    throw new Error('simulated audit storage failure');
  };

  assert.throws(() => service.add('must roll back', {}, {
    tenantId: 'tenant-sqlite-a',
    memoryScope: 'personal',
    operationId: 'sqlite-audit-failure'
  }));

  persistence.memoryAudit.append = originalAppend;
  assert.equal(persistence.memory.findByFingerprint({
    tenantId: 'tenant-sqlite-a',
    scope: 'personal',
    type: 'note',
    text: 'must roll back'
  }), null);
  assert.equal(persistence.memoryAudit.findByOperationId(
    'sqlite-audit-failure', 'tenant-sqlite-a', 'personal'
  ).length, 0);
  assert.equal(publishedEvents, 0, 'rolled-back audit events must never be published');
});

test('SQLite transaction coordinator rejects asynchronous callbacks instead of committing early', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-memory-async-'));
  const filePath = path.join(directory, 'orient.db');
  const persistence = new SqlitePersistence({ filePath });
  t.after(() => {
    try { persistence.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(
    () => persistence.memoryTransactionCoordinator.run(async () => 'not allowed'),
    /must be synchronous/
  );
});
