const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SqlitePersistence =
  require('../../../src/infrastructure/persistence/sqlite/sqlite-persistence');

const ApprovalService =
  require('../../../src/core/agent/approval/approval-service');
const WorkflowDefinition = require('../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../src/core/workflow/workflow-instance');

test('SQLite workflow repository resolves the durable approval-to-workflow mapping', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-approval-workflow-'));
  try {
    const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.db') });
    const definition = new WorkflowDefinition({
      id: 'approval-mapping',
      version: 1,
      name: 'Approval mapping',
      steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME' }]
    });
    const instance = new WorkflowInstance({
      definition,
      workflowId: 'workflow-sqlite-approval-map',
      tenantId: 'tenant-a',
      input: { text: 'guarded operation' }
    });
    instance.transition('QUEUED');
    instance.transition('RUNNING');
    instance.transition('WAITING');
    instance.metadata = { approvalBlocked: true, approvalExecutionId: 'execution-sqlite-approval-map', approvalId: 'approval-sqlite-map' };
    persistence.workflows.save(instance, 'tenant-a');

    const found = persistence.workflows.findByApprovalExecutionId({
      executionId: 'execution-sqlite-approval-map',
      tenantId: 'tenant-a'
    });
    assert.equal(found.workflowId, 'workflow-sqlite-approval-map');
    assert.equal(found.metadata.approvalId, 'approval-sqlite-map');
    assert.equal(persistence.workflows.findByApprovalExecutionId({
      executionId: 'execution-sqlite-approval-map',
      tenantId: 'tenant-other'
    }), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

test('SQLite execution pages and event replay are bounded and tenant-scoped', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-pages-'));
  const filePath = path.join(directory, 'orient.db');
  try {
    const persistence = new SqlitePersistence({ filePath });
    persistence.executions.insert({ executionId: 'exec-a1', status: 'completed', updatedAt: '2026-10-10T10:00:00.000Z', metadata: { tenantId: 'tenant-a' } }, { tenantId: 'tenant-a' });
    persistence.executions.insert({ executionId: 'exec-a2', status: 'running', updatedAt: '2026-10-10T11:00:00.000Z', metadata: { tenantId: 'tenant-a' } }, { tenantId: 'tenant-a' });
    persistence.executions.insert({ executionId: 'exec-b1', status: 'failed', updatedAt: '2026-10-10T12:00:00.000Z', metadata: { tenantId: 'tenant-b' } }, { tenantId: 'tenant-b' });
    const page = persistence.executions.findPage({ tenantId: 'tenant-a', limit: 1, offset: 1 });
    assert.equal(page.total, 2);
    assert.deepEqual(page.executions.map(item => item.executionId), ['exec-a1']);

    persistence.events.append({ id: 'a1', executionId: 'exec-a1', type: 'step', timestamp: '2026-10-10T10:00:00.000Z', data: { tenantId: 'tenant-a' } }, { tenantId: 'tenant-a' });
    persistence.events.append({ id: 'a2', executionId: 'exec-a1', type: 'step', timestamp: '2026-10-10T10:00:01.000Z', data: { tenantId: 'tenant-a' } }, { tenantId: 'tenant-a' });
    persistence.events.append({ id: 'a3', executionId: 'exec-a1', type: 'step', timestamp: '2026-10-10T10:00:02.000Z', data: { tenantId: 'tenant-a' } }, { tenantId: 'tenant-a' });
    persistence.events.append({ id: 'b4', executionId: 'exec-a1', type: 'foreign', timestamp: '2026-10-10T10:00:03.000Z', data: { tenantId: 'tenant-b' } }, { tenantId: 'tenant-b' });
    const events = persistence.events.findByExecutionId('exec-a1', { tenantId: 'tenant-a', limit: 2 });
    assert.deepEqual(events.map(event => event.id), ['a2', 'a3']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite approval storage survives restart and remains single-use', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-approval-'));
  const filePath = path.join(directory, 'orient.db');

  const firstPersistence = new SqlitePersistence({ filePath });
  const firstApproval = new ApprovalService({
    repository: firstPersistence.approvals,
    tenantId: 'tenant-a',
    decisionAuthorizer: async () => true
  });

  const issued = await firstApproval.issue({
    executionId: 'exec-approval-1',
    step: 1,
    planRevision: 2,
    tool: 'test.sensitive',
    capability: 'sensitive.execute',
    scope: { planRevision: 2 }
  });

  await firstApproval.decide({ approvalId: issued.approvalId, executionId: 'exec-approval-1', decision: 'approved', actorId: 'owner-test', tenantId: 'tenant-a' });

  const secondPersistence = new SqlitePersistence({ filePath });
  const secondApproval = new ApprovalService({
    repository: secondPersistence.approvals,
    tenantId: 'tenant-a'
  });

  const validation = await secondApproval.validate({
    approval: issued,
    executionId: 'exec-approval-1',
    step: 1,
    planRevision: 2,
    tool: 'test.sensitive',
    capability: 'sensitive.execute',
    scope: { planRevision: 2 }
  });

  assert.equal(validation.allowed, true);
  const durableExecutionApprovals = await secondApproval.listForExecution({ executionId: 'exec-approval-1', tenantId: 'tenant-a' });
  assert.equal(durableExecutionApprovals.length, 1);
  assert.equal(durableExecutionApprovals[0].approvalId, issued.approvalId);
  const durablePending = await secondApproval.listPending({ tenantId: 'tenant-a' });
  assert.equal(durablePending.length, 0, 'a decided approval must no longer appear in the pending inbox');
  assert.equal(await secondApproval.consume(issued.approvalId), true);
  assert.equal(await secondApproval.consume(issued.approvalId), false);

  fs.rmSync(directory, { recursive: true, force: true });
});


test('SQLite checkpoint sequencing remains monotonic and schema migration marker is durable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-migration-'));
  const filePath = path.join(directory, 'orient.db');

  const first = new SqlitePersistence({ filePath });
  first.checkpoints.save({ executionId: 'exec-seq-1', status: 'running', currentStep: 1 });
  first.checkpoints.save({ executionId: 'exec-seq-1', status: 'running', currentStep: 2 });

  const migrationRows = first.db.query('SELECT version FROM schema_migrations ORDER BY version ASC;');
  assert.deepEqual(migrationRows.map(row => Number(row.version)), [1, 2]);
  assert.equal(first.checkpoints.findLatest('exec-seq-1').sequence, 2);

  const second = new SqlitePersistence({ filePath });
  second.checkpoints.save({ executionId: 'exec-seq-1', status: 'running', currentStep: 3 });
  assert.equal(second.checkpoints.findLatest('exec-seq-1').sequence, 3);

  fs.rmSync(directory, { recursive: true, force: true });
});


test('sqlite transactions roll back all statements after an injected failure', () => {
  const SqliteDatabase = require('../../../src/infrastructure/persistence/sqlite/sqlite-database');
  const db = new SqliteDatabase(':memory:');

  assert.throws(
    () => db.transaction([
      "INSERT INTO events(event_id,type,timestamp,payload) VALUES ('rollback-event','test','2026-01-01T00:00:00.000Z','{}');",
      'THIS IS NOT VALID SQL;'
    ])
  );

  assert.equal(db.query("SELECT COUNT(*) AS count FROM events WHERE event_id='rollback-event';")[0].count, 0);
});


test('SQLite approval consumption rejects pending, rejected, expired and malformed challenges', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-approval-gates-'));
  try {
    const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.db') });
    const now = Date.now();
    const base = {
      step: 1,
      planRevision: 1,
      tool: 'danger.write',
      capability: 'external.write',
      issuedAt: new Date(now - 1000).toISOString(),
      used: false,
      tenantId: 'tenant-a',
      metadata: { tenantId: 'tenant-a' }
    };
    const records = [
      { ...base, approvalId: 'sqlite-pending', executionId: 'exec-pending', expiresAt: new Date(now + 60000).toISOString() },
      { ...base, approvalId: 'sqlite-rejected', executionId: 'exec-rejected', expiresAt: new Date(now + 60000).toISOString(), decision: { status: 'rejected', actorId: 'owner', decidedAt: new Date(now).toISOString() } },
      { ...base, approvalId: 'sqlite-expired', executionId: 'exec-expired', expiresAt: new Date(now - 1000).toISOString(), decision: { status: 'approved', actorId: 'owner', decidedAt: new Date(now - 2000).toISOString() } },
      { ...base, approvalId: 'sqlite-malformed', executionId: 'exec-malformed', expiresAt: 'not-a-date', decision: { status: 'approved', actorId: 'owner', decidedAt: new Date(now).toISOString() } }
    ];
    for (const record of records) persistence.approvals.save(record, { tenantId: 'tenant-a' });
    const requestedAt = new Date(now).toISOString();
    for (const record of records) {
      assert.equal(persistence.approvals.consume(record.approvalId, requestedAt, 'tenant-a'), false, record.approvalId);
      assert.equal(persistence.approvals.findById(record.approvalId, { tenantId: 'tenant-a' }).used, false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('SQLite idempotency keys are tenant-scoped across begin, completion, failure, and deletion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-idempotency-tenants-'));
  const filePath = path.join(directory, 'orient.db');
  try {
    const first = new SqlitePersistence({ filePath });
    const common = { executionId: 'exec-shared', step: 1, tool: 'test.write', operationId: 'shared-operation' };
    const a = first.idempotency.begin({ ...common, tenantId: 'tenant-a' });
    const b = first.idempotency.begin({ ...common, tenantId: 'tenant-b' });
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.equal(first.idempotency.begin({ ...common, tenantId: 'tenant-a' }).created, false);
    assert.equal(first.idempotency.findByKey(a.key, { tenantId: 'tenant-a' }).tenantId, 'tenant-a');
    assert.equal(first.idempotency.findByKey(b.key, { tenantId: 'tenant-b' }).tenantId, 'tenant-b');
    assert.equal(first.idempotency.findByKey(a.key, { tenantId: 'tenant-c' }), null);

    first.idempotency.complete(a.key, { owner: 'tenant-a' }, { tenantId: 'tenant-a' });
    assert.equal(first.idempotency.findByKey(b.key, { tenantId: 'tenant-b' }).status, 'running');
    assert.equal(first.idempotency.fail(b.key, { code: 'TEST', message: 'tenant b failure' }, { tenantId: 'tenant-b' }).status, 'failed');

    const restarted = new SqlitePersistence({ filePath });
    assert.equal(restarted.idempotency.findByKey(a.key, { tenantId: 'tenant-a' }).result.owner, 'tenant-a');
    assert.equal(restarted.idempotency.findByKey(b.key, { tenantId: 'tenant-b' }).status, 'failed');
    assert.equal(restarted.idempotency.delete(a.key, { tenantId: 'tenant-c' }), false);
    assert.equal(restarted.idempotency.findByKey(a.key, { tenantId: 'tenant-a' }).status, 'completed');
    assert.equal(restarted.idempotency.delete(a.key, { tenantId: 'tenant-a' }), true);
    assert.equal(restarted.idempotency.findByKey(b.key, { tenantId: 'tenant-b' }).status, 'failed');
    assert.deepEqual(
      restarted.db.query('PRAGMA table_info(idempotency);').filter(column => Number(column.pk) > 0).map(column => column.name),
      ['tenant_id', 'key']
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
