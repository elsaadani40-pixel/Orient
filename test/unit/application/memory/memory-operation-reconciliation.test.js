const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const JsonMemoryRepository = require('../../../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../../../src/infrastructure/memory/memory-audit.repository');
const MemoryTransactionCoordinator = require('../../../../src/infrastructure/memory/memory-transaction-coordinator');
const MemoryService = require('../../../../src/application/memory/memory.service');

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-operation-reconcile-'));
  const memoryFile = path.join(directory, 'memory.json');
  const auditFile = path.join(directory, 'memory-audit.json');
  const coordinator = new MemoryTransactionCoordinator({
    memoryFile,
    auditFile,
    journalFile: path.join(directory, 'memory-transaction-journal.json')
  });
  coordinator.recover();
  const repository = new JsonMemoryRepository(memoryFile);
  const auditRepository = new MemoryAuditRepository(auditFile);
  const service = new MemoryService(repository, {
    auditRepository,
    transactionCoordinator: coordinator
  });
  return { directory, coordinator, repository, auditRepository, service };
}

test('memory.add reconciliation returns the committed memory from its tenant-scoped audit receipt', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const context = {
    tenantId: 'tenant-a',
    memoryScope: 'personal',
    operationId: 'operation-add-a'
  };

  const created = fixture.service.add('reconciliation receipt test', {}, context);
  const reconciled = fixture.service.reconcileToolOperation('memory.add', {
    text: 'reconciliation receipt test'
  }, context);

  assert.equal(reconciled.status, 'completed');
  assert.equal(reconciled.result.id, created.id);
  assert.equal(reconciled.result.tenantId, 'tenant-a');
  assert.equal(
    fixture.auditRepository.findByOperationId('operation-add-a', 'tenant-a', 'personal').length,
    1
  );
  assert.equal(
    fixture.auditRepository.findByOperationId('operation-add-a', 'tenant-b', 'personal').length,
    0
  );
});


test('memory.add reconciliation survives process exit after commit but before execution completion is recorded', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '../../../../');
  const script = `
    const root = ${JSON.stringify(root)};
    const directory = ${JSON.stringify(fixture.directory)};
    const path = require('node:path');
    const Coordinator = require(path.join(root, 'src/infrastructure/memory/memory-transaction-coordinator'));
    const Repository = require(path.join(root, 'src/infrastructure/memory/json-memory.repository'));
    const AuditRepository = require(path.join(root, 'src/infrastructure/memory/memory-audit.repository'));
    const Service = require(path.join(root, 'src/application/memory/memory.service'));
    const coordinator = new Coordinator({
      memoryFile: path.join(directory, 'memory.json'),
      auditFile: path.join(directory, 'memory-audit.json'),
      journalFile: path.join(directory, 'memory-transaction-journal.json')
    });
    coordinator.recover();
    const service = new Service(
      new Repository(path.join(directory, 'memory.json')),
      { auditRepository: new AuditRepository(path.join(directory, 'memory-audit.json')), transactionCoordinator: coordinator }
    );
    service.add('crash-window reconciliation test', {}, {
      tenantId: 'tenant-crash',
      memoryScope: 'personal',
      operationId: 'operation-crash-after-commit'
    });
    // Simulate a process crash after the transactional tool mutation committed,
    // but before the AgentLoop could persist idempotency completion.
    process.exit(23);
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr || child.stdout);

  const coordinator = new MemoryTransactionCoordinator({
    memoryFile: path.join(fixture.directory, 'memory.json'),
    auditFile: path.join(fixture.directory, 'memory-audit.json'),
    journalFile: path.join(fixture.directory, 'memory-transaction-journal.json')
  });
  assert.deepEqual(coordinator.recover(), { recovered: false, phase: null });
  const repository = new JsonMemoryRepository(path.join(fixture.directory, 'memory.json'));
  const auditRepository = new MemoryAuditRepository(path.join(fixture.directory, 'memory-audit.json'));
  const restartedService = new MemoryService(repository, {
    auditRepository,
    transactionCoordinator: coordinator
  });

  const reconciled = restartedService.reconcileToolOperation('memory.add', {
    text: 'crash-window reconciliation test'
  }, {
    tenantId: 'tenant-crash',
    memoryScope: 'personal',
    operationId: 'operation-crash-after-commit'
  });
  assert.equal(reconciled.status, 'completed');
  assert.equal(reconciled.result.text, 'crash-window reconciliation test');
});

test('memory.delete reconciliation reports completion only when its durable archive receipt exists', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const createContext = {
    tenantId: 'tenant-a',
    memoryScope: 'personal',
    operationId: 'operation-create-before-delete'
  };
  const created = fixture.service.add('delete reconciliation receipt test', {}, createContext);
  const deleteContext = {
    tenantId: 'tenant-a',
    memoryScope: 'personal',
    operationId: 'operation-delete-a'
  };

  assert.equal(fixture.service.delete(created.id, deleteContext), true);
  assert.deepEqual(
    fixture.service.reconcileToolOperation('memory.delete', { id: created.id }, deleteContext),
    { status: 'completed', result: true }
  );
  assert.equal(
    fixture.auditRepository.findByOperationId('operation-delete-a', 'tenant-a', 'personal')[0].action,
    'memory.archived'
  );
});

test('memory reconciliation fails closed when no committed operation receipt exists', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const result = fixture.service.reconcileToolOperation('memory.add', {
    text: 'not committed'
  }, {
    tenantId: 'tenant-a',
    memoryScope: 'personal',
    operationId: 'operation-without-receipt'
  });

  assert.deepEqual(result, {
    status: 'unknown',
    reason: 'no_committed_receipt_for_operation'
  });
});

test('memory reconciliation fails closed without the durable transaction coordinator', () => {
  const service = new MemoryService({
    findById() { return null; }
  }, {
    auditRepository: { findByOperationId() { return []; } }
  });

  assert.deepEqual(service.reconcileToolOperation('memory.add', {}, {
    tenantId: 'tenant-a',
    operationId: 'operation-without-coordinator'
  }), {
    status: 'unknown',
    reason: 'durable_operation_receipts_unavailable'
  });
});
