'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JsonMemoryRepository = require('../../../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../../../src/infrastructure/memory/memory-audit.repository');
const MemoryTransactionCoordinator = require('../../../../src/infrastructure/memory/memory-transaction-coordinator');
const MemoryService = require('../../../../src/application/memory/memory.service');

test('JSON MemoryService awaits async journal transactions and preserves audit consistency', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-json-memory-async-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memoryFile = path.join(directory, 'memories.json');
  const auditFile = path.join(directory, 'audit.json');
  const coordinator = new MemoryTransactionCoordinator({
    memoryFile,
    auditFile,
    journalFile: path.join(directory, 'memory-transaction-journal.json')
  });
  coordinator.recover();

  const repository = new JsonMemoryRepository(memoryFile);
  const audit = new MemoryAuditRepository(auditFile);
  const service = new MemoryService(repository, {
    auditRepository: audit,
    transactionCoordinator: coordinator
  });
  const context = { agentId: 'ORIENT_RUNTIME', tenantId: 'tenant-json-async' };

  const created = await service.add('JSON asynchronous memory proof', { type: 'fact' }, context);
  assert.ok(created.id);
  assert.equal((await service.list('asynchronous memory', context)).length, 1);
  assert.equal((await service.history(created.id, context)).some(event => event.action === 'memory.created'), true);

  const before = repository.findById(created.id, context.tenantId, 'personal');
  const originalAppend = audit.append.bind(audit);
  audit.append = event => {
    if (event.action === 'memory.archived') throw new Error('injected json audit failure');
    return originalAppend(event);
  };
  await assert.rejects(() => service.delete(created.id, context), /injected json audit failure/);
  assert.equal(repository.findById(created.id, context.tenantId, 'personal').state, before.state);
  assert.equal(await service.count(context), 1);
});
