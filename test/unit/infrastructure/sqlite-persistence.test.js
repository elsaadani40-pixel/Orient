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

  first.close();
  second.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('SQLite repositories bind untrusted identifiers as data and support true in-memory databases', () => {
  const SqliteDatabase = require('../../../src/infrastructure/persistence/sqlite/sqlite-database');
  const memory = new SqliteDatabase(':memory:');
  assert.equal(memory.filePath, ':memory:');
  const identifier = "exec'; DROP TABLE executions; --";
  memory.run('INSERT INTO executions(execution_id, payload, updated_at) VALUES (?, ?, ?)', [
    identifier, JSON.stringify({ executionId: identifier, metadata: { tenantId: 'local' } }), new Date().toISOString()
  ]);
  assert.equal(memory.query('SELECT execution_id FROM executions WHERE execution_id = ?', [identifier])[0].execution_id, identifier);
  assert.equal(Number(memory.query('SELECT COUNT(*) AS count FROM executions')[0].count), 1);
  memory.close();
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
    persistence.close();
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

  await firstApproval.decide({ approvalId: issued.approvalId, executionId: 'exec-approval-1', decision: 'approved', actorId: 'test-owner', tenantId: 'tenant-a' });

  const secondPersistence = new SqlitePersistence({ filePath });
  const secondApproval = new ApprovalService({
    repository: secondPersistence.approvals,
    tenantId: 'tenant-a',
    decisionAuthorizer: async () => true
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
  // A decided approval is no longer pending review, but remains durable for validation.
  assert.equal(durablePending.length, 0);
  assert.equal(await secondApproval.consume(issued.approvalId), true);
  assert.equal(await secondApproval.consume(issued.approvalId), false);

  firstPersistence.close();
  secondPersistence.close();
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

  first.close();
  second.close();
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
  db.close();
});


test('SQLite mission event append assigns stable tenant-scoped sequences and rejects ID reuse', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-mission-events-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.db') });
  try {
    const event = {
      id: 'mission-sqlite-1', aggregateId: 'workflow-sqlite-1', executionId: 'workflow-sqlite-1',
      type: 'workflow.approval.required', timestamp: '2026-11-09T10:00:00.000Z',
      data: { tenantId: 'tenant-a', approvalId: 'approval-1' }
    };
    const first = persistence.events.appendMissionEvent(event, { tenantId: 'tenant-a' });
    const replay = persistence.events.appendMissionEvent(event, { tenantId: 'tenant-a' });
    const second = persistence.events.appendMissionEvent({
      ...event, id: 'mission-sqlite-2', type: 'workflow.state.changed'
    }, { tenantId: 'tenant-a' });
    const isolated = persistence.events.appendMissionEvent({
      ...event, id: 'mission-sqlite-b1', data: { tenantId: 'tenant-b' }
    }, { tenantId: 'tenant-b' });
    assert.equal(first.sequence, 1);
    assert.equal(replay.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(isolated.sequence, 1);
    assert.deepEqual(
      persistence.events.findByAggregateId('workflow-sqlite-1', { tenantId: 'tenant-a' }).map(item => item.sequence),
      [1, 2]
    );
    assert.throws(
      () => persistence.events.appendMissionEvent({
        ...event, type: 'workflow.step.failed'
      }, { tenantId: 'tenant-a' }),
      error => error.code === 'MISSION_EVENT_ID_CONFLICT'
    );
  } finally {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite pending-publication index tolerates valid non-array legacy JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-pending-json-'));
  const SqliteDatabase = require('../../../src/infrastructure/persistence/sqlite/sqlite-database');
  const db = new SqliteDatabase(path.join(directory, 'orient.db'));
  try {
    assert.doesNotThrow(() => db.run(
      'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES(?,?,?,?,?)',
      ['legacy-object', 'tenant-a', 'WAITING', '2026-11-09T10:00:00.000Z',
        JSON.stringify({ workflowId: 'legacy-object', metadata: { approvalBlocked: true, pendingPublications: { malformed: true } } })]
    ));
    assert.doesNotThrow(() => db.run(
      'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES(?,?,?,?,?)',
      ['legacy-string', 'tenant-a', 'WAITING', '2026-11-09T10:00:01.000Z',
        JSON.stringify({ workflowId: 'legacy-string', metadata: { approvalBlocked: true, pendingPublications: 'legacy' } })]
    ));
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('SQLite workflow outbox is bounded, tenant-scoped, and revision-checked', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-workflow-outbox-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.db') });
  try {
    persistence.workflows.save({
      workflowId: 'wf-pending-a', tenantId: 'tenant-a', state: 'WAITING',
      updatedAt: '2026-11-09T10:00:00.000Z',
      checkpoint: { revision: 1 },
      metadata: { approvalBlocked: true, pendingPublications: [{ eventId: 'event-a1' }, { eventId: 'event-a2' }] }
    }, 'tenant-a');
    persistence.workflows.save({
      workflowId: 'wf-pending-b', tenantId: 'tenant-b', state: 'WAITING',
      updatedAt: '2026-11-09T10:00:01.000Z',
      checkpoint: { revision: 1 },
      metadata: { approvalBlocked: true, pendingPublications: [{ eventId: 'event-b1' }] }
    }, 'tenant-b');
    assert.deepEqual(
      persistence.workflows.findPendingPublications({ tenantId: 'tenant-a', limit: 1 }).map(item => item.workflowId),
      ['wf-pending-a']
    );
    const ack = persistence.workflows.acknowledgePendingPublications('wf-pending-a', 'tenant-a', ['event-a1']);
    assert.equal(ack.acknowledged, 1);
    assert.equal(ack.revision, 2);
    assert.deepEqual(ack.pending, [{ eventId: 'event-a2' }]);
    assert.deepEqual(
      persistence.workflows.findPendingPublications({ tenantId: 'tenant-a' }).map(item => item.workflowId),
      ['wf-pending-a']
    );
    assert.throws(
      () => persistence.workflows.acknowledgePendingPublications('wf-pending-a', 'tenant-b', ['event-a2']),
      error => error.code === 'WORKFLOW_NOT_FOUND'
    );
  } finally {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('SQLite workflow repair uses revision compare-and-set and rejects stale writers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-workflow-repair-'));
  const filePath = path.join(directory, 'orient.db');
  const first = new SqlitePersistence({ filePath });
  const second = new SqlitePersistence({ filePath });
  try {
    const snapshot = {
      workflowId: 'wf-repair-sqlite',
      tenantId: 'tenant-a',
      state: 'WAITING',
      updatedAt: new Date().toISOString(),
      checkpoint: { revision: 3 },
      metadata: {}
    };
    first.workflows.save(snapshot, 'tenant-a');
    const repaired = first.workflows.repair({
      ...snapshot,
      state: 'QUEUED',
      toJSON() { return this; }
    }, { tenantId: 'tenant-a', expectedRevision: 3, targetRevision: 3 });
    assert.equal(repaired.checkpoint.revision, 3);
    assert.equal(first.workflows.findById(snapshot.workflowId, 'tenant-a').state, 'QUEUED');
    assert.throws(
      () => second.workflows.repair({
        ...snapshot,
        state: 'RUNNING',
        toJSON() { return this; }
      }, { tenantId: 'tenant-a', expectedRevision: 3, targetRevision: 4 }),
      error => error.code === 'WORKFLOW_CHECKPOINT_CONFLICT'
    );
  } finally {
    first.close();
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite workflow repair refuses to overwrite an active worker lease', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-workflow-repair-lease-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.db') });
  try {
    const snapshot = {
      workflowId: 'wf-repair-leased',
      tenantId: 'tenant-a',
      state: 'RUNNING',
      updatedAt: new Date().toISOString(),
      checkpoint: { revision: 1 },
      metadata: {}
    };
    persistence.workflows.save(snapshot, 'tenant-a');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    persistence.db.run(
      'INSERT INTO workflow_leases(workflow_id,lease_id,worker_id,acquired_at,expires_at,payload) VALUES(?,?,?,?,?,?)',
      [snapshot.workflowId, 'lease-active', 'worker-active', now, expiresAt,
        JSON.stringify({ workflowId: snapshot.workflowId, leaseId: 'lease-active', metadata: { tenantId: 'tenant-a' } })]
    );
    assert.throws(
      () => persistence.workflows.repair({
        ...snapshot,
        state: 'QUEUED',
        toJSON() { return this; }
      }, { tenantId: 'tenant-a', expectedRevision: 1, targetRevision: 2 }),
      error => error.code === 'WORKFLOW_LEASE_HELD'
    );
  } finally {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('SQLite rejects worker mission-event and workflow writes until atomic durable fencing is implemented', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-worker-fencing-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.db') });
  const workerPrincipal = {
    tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'session-a',
    workflowId: 'workflow-a', leaseId: 'lease-a', fencingToken: 1
  };
  try {
    assert.throws(
      () => persistence.events.appendMissionEvent({
        id: 'worker-event-1', aggregateId: 'workflow-a',
        type: 'workflow.step.completed', data: { tenantId: 'tenant-a' }
      }, { tenantId: 'tenant-a', workerPrincipal }),
      error => error.code === 'WORKER_DURABLE_FENCING_UNSUPPORTED' && error.status === 503
    );
    assert.throws(
      () => persistence.workflows.save({
        workflowId: 'workflow-a', tenantId: 'tenant-a', state: 'RUNNING',
        metadata: { fencingToken: 1 }, checkpoint: { revision: 0 }
      }, 'tenant-a', { workerPrincipal }),
      error => error.code === 'WORKER_DURABLE_FENCING_UNSUPPORTED' && error.status === 503
    );
    assert.equal(persistence.events.findByAggregateId('workflow-a', { tenantId: 'tenant-a' }).length, 0);
    assert.equal(persistence.workflows.findById('workflow-a', 'tenant-a'), null);
  } finally {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
