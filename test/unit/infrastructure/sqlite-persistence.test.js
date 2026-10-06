const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SqlitePersistence =
  require('../../../src/infrastructure/persistence/sqlite/sqlite-persistence');

const ApprovalService =
  require('../../../src/core/agent/approval/approval-service');

test('SQLite persistence survives repository recreation and preserves execution state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-'));
  const filePath = path.join(directory, 'orient.db');

  const first = new SqlitePersistence({ filePath });

  first.executions.insert({
    executionId: 'exec-sqlite-1',
    status: 'running',
    metadata: { durable: true }
  });

  first.checkpoints.save({
    executionId: 'exec-sqlite-1',
    status: 'running',
    currentStep: 3
  }, { reason: 'step_completed' });

  first.idempotency.begin({
    executionId: 'exec-sqlite-1',
    step: 3,
    tool: 'test.write',
    planRevision: 1,
    operationId: 'operation-sqlite-1'
  });

  first.events.append({
    id: 'event-sqlite-1',
    executionId: 'exec-sqlite-1',
    type: 'checkpoint.saved',
    data: { step: 3 }
  });

  const second = new SqlitePersistence({ filePath });

  assert.equal(second.executions.findById('exec-sqlite-1').metadata.durable, true);
  assert.equal(second.checkpoints.findLatest('exec-sqlite-1').snapshot.currentStep, 3);
  assert.equal(
    second.idempotency.find({ executionId: 'exec-sqlite-1', step: 3, tool: 'test.write', planRevision: 1, operationId: 'operation-sqlite-1' }).operationId,
    'operation-sqlite-1'
  );
  assert.equal(second.events.findByExecutionId('exec-sqlite-1').length, 1);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('SQLite approval storage survives restart and remains single-use', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-approval-'));
  const filePath = path.join(directory, 'orient.db');

  const firstPersistence = new SqlitePersistence({ filePath });
  const firstApproval = new ApprovalService({
    repository: firstPersistence.approvals
  });

  const issued = firstApproval.issue({
    executionId: 'exec-approval-1',
    step: 1,
    planRevision: 2,
    tool: 'test.sensitive',
    capability: 'sensitive.execute',
    scope: { planRevision: 2 }
  });

  const secondPersistence = new SqlitePersistence({ filePath });
  const secondApproval = new ApprovalService({
    repository: secondPersistence.approvals
  });

  const validation = secondApproval.validate({
    approval: issued,
    executionId: 'exec-approval-1',
    step: 1,
    planRevision: 2,
    tool: 'test.sensitive',
    capability: 'sensitive.execute',
    scope: { planRevision: 2 }
  });

  assert.equal(validation.allowed, true);
  assert.equal(secondApproval.consume(issued.approvalId), true);
  assert.equal(secondApproval.consume(issued.approvalId), false);

  fs.rmSync(directory, { recursive: true, force: true });
});


test('SQLite checkpoint sequencing remains monotonic and schema migration marker is durable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-migration-'));
  const filePath = path.join(directory, 'orient.db');

  const first = new SqlitePersistence({ filePath });
  first.checkpoints.save({ executionId: 'exec-seq-1', status: 'running', currentStep: 1 });
  first.checkpoints.save({ executionId: 'exec-seq-1', status: 'running', currentStep: 2 });

  const migrationRows = first.db.query('SELECT version FROM schema_migrations ORDER BY version ASC;');
  assert.deepEqual(migrationRows.map(row => Number(row.version)), [1]);
  assert.equal(first.checkpoints.findLatest('exec-seq-1').sequence, 2);

  const second = new SqlitePersistence({ filePath });
  second.checkpoints.save({ executionId: 'exec-seq-1', status: 'running', currentStep: 3 });
  assert.equal(second.checkpoints.findLatest('exec-seq-1').sequence, 3);

  fs.rmSync(directory, { recursive: true, force: true });
});
