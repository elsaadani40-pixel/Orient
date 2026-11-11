const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PostgresPersistence,
  PostgresEventRepository,
  PostgresExecutionRepository,
  PostgresApprovalRepository,
  PostgresIdempotencyRepository,
  PostgresWorkflowLeaseRepository,
  PostgresWorkflowRepository,
  PostgresCheckpointRepository
} = require('../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const PostgresTenantQuotaRepository = require('../../../../src/infrastructure/persistence/postgres/postgres-tenant-quota-repository');
const { MIGRATIONS } = require('../../../../src/infrastructure/persistence/postgres/postgres-database');
const { createWorkerPersistencePrincipal } = require('../../../../src/core/security/worker-persistence-principal');
const { createPersistencePrincipal } = require('../../../../src/core/security/persistence-principal');

function fakeDb(responses = []) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      return responses.shift() || { rows: [], rowCount: 0 };
    },
    async transactionWithWorkerPrincipal(principal, work) { return this.transaction(work); },
    async transactionWithPrincipal(principal, work) { return this.transaction(work); },
    async transaction(work) {
      const client = {
        query: async (text, values = []) => {
          calls.push({ text, values });
          return responses.shift() || { rows: [], rowCount: 0 };
        }
      };
      return work(client);
    }
  };
}

test('PostgresPersistence exposes every durable repository without opening a database connection', () => {
  const db = fakeDb();
  const persistence = new PostgresPersistence({ pool: db });
  assert.ok(persistence.executions);
  assert.ok(persistence.events);
  assert.ok(persistence.idempotency);
  assert.ok(persistence.checkpoints);
  assert.ok(persistence.workflows);
  assert.strictEqual(persistence.workflows.eventRepository, persistence.events);
  assert.ok(persistence.workflowLeases);
  assert.ok(persistence.approvals);
});

test('Postgres event writes bind tenant identity as a parameter', async () => {
  const db = fakeDb([{ rows: [], rowCount: 1 }]);
  const repo = new PostgresEventRepository(db);
  const event = await repo.append({
    id: 'event-1',
    type: 'execution.completed',
    data: {}
  }, { tenantId: 'tenant-a' });

  assert.equal(event.data.tenantId, 'tenant-a');
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].values.slice(0, 2), ['event-1', 'tenant-a']);
  assert.match(db.calls[0].text, /ON CONFLICT\(event_id\) DO NOTHING/);
});

test('Postgres idempotency begin is tenant-scoped and conflict-safe', async () => {
  const db = fakeDb([
    { rows: [], rowCount: 1 }
  ]);
  const repo = new PostgresIdempotencyRepository(db);
  const result = await repo.begin({
    executionId: 'exec-1',
    step: 1,
    tool: 'memory.read',
    tenantId: 'tenant-a'
  });

  assert.equal(result.created, true);
  assert.equal(result.record.tenantId, 'tenant-a');
  assert.equal(db.calls[0].values[1], 'tenant-a');
  assert.match(db.calls[0].text, /ON CONFLICT\(tenant_id,key\) DO NOTHING/);
});

test('Postgres persistence rejects cross-tenant writes before SQL execution', async () => {
  const db = fakeDb();
  const repo = new PostgresEventRepository(db);
  await assert.rejects(
    () => repo.append({ id: 'event-2', type: 'x', data: { tenantId: 'tenant-b' } }, { tenantId: 'tenant-a' }),
    error => error.code === 'TENANT_PERSISTENCE_MISMATCH'
  );
  assert.equal(db.calls.length, 0);
});


function workerLeaseFixture(responses, { tenantId = 'tenant-a', workerId, sessionId = 'session-1' }) {
  const db = fakeDb(responses);
  return {
    db,
    repo: new PostgresWorkflowLeaseRepository(db),
    workerPrincipal: createWorkerPersistencePrincipal({ tenantId, workerId, sessionId, capabilities: [] })
  };
}

test('Postgres claimed lease acquisition consumes the exact claim in one transaction', async () => {
  const { db, repo, workerPrincipal: principal } = workerLeaseFixture([
    { rows: [{ session_id: 'session-1' }], rowCount: 1 },
    { rows: [{ capabilities: [] }], rowCount: 1 },
    { rows: [{ state: 'QUEUED', payload: { workflowId: 'wf-atomic', state: 'QUEUED' } }], rowCount: 1 },
    { rows: [{ claimed_at: '2026-11-11T10:00:00.000Z', expires_at: '2026-11-11T10:00:05.000Z' }], rowCount: 1 },
    { rows: [], rowCount: 0 }, { rows: [], rowCount: 0 },
    { rows: [{ session_id: 'session-1' }], rowCount: 1 },
    { rows: [{ capabilities: [] }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ fencing_token: '42' }], rowCount: 1 },
    { rows: [{ workflow_id: 'wf-atomic' }], rowCount: 1 }
  ], { workerId: 'worker-a' });
  const result = await repo.tryAcquireClaimed({
    workflowId: 'wf-atomic', leaseId: 'lease-atomic', workerId: 'worker-a',
    acquiredAt: Date.parse('2026-11-11T10:00:01.000Z'), expiresAt: Date.parse('2026-11-11T10:00:31.000Z'),
    metadata: { tenantId: 'tenant-a' }
  }, {
    tenantId: 'tenant-a', workflowId: 'wf-atomic', workerId: 'worker-a',
    workerSessionId: 'session-1', claimedAt: '2026-11-11T10:00:00.000Z', expiresAt: '2026-11-11T10:00:05.000Z'
  }, 'tenant-a', { workerPrincipal: principal });
  assert.equal(result.fencingToken, 42);
  const sql = db.calls.map(call => call.text).join('\n');
  assert.ok(sql.includes('FOR UPDATE'));
  assert.ok(sql.includes('INSERT INTO workflow_leases'));
  assert.ok(sql.includes('DELETE FROM workflow_dispatch_claims'));
  assert.ok(sql.includes('RETURNING workflow_id'));
});

test('Postgres expired lease cleanup uses database decision time, not the application clock', async () => {
  const db = fakeDb([{ rows: [], rowCount: 0 }]);
  const repo = new PostgresWorkflowLeaseRepository(db);

  // A far-future application timestamp must not authorize early deletion.
  await repo.deleteExpired('wf-clock-skew', 'lease-clock-skew',
    Date.parse('2099-01-01T00:00:00.000Z'), 'tenant-a');

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].text, /expires_at <= clock_timestamp\(\)/);
  assert.doesNotMatch(db.calls[0].text, /expires_at <= \$\d+/);
  assert.deepEqual(db.calls[0].values, ['wf-clock-skew', 'lease-clock-skew', 'tenant-a']);
});

test('Postgres workflow lease acquisition returns a durable fencing token', async () => {
  const { db, repo, workerPrincipal } = workerLeaseFixture([
    { rows: [{ session_id: 'session-1' }], rowCount: 1 },
    { rows: [{ capabilities: [] }], rowCount: 1 },
    { rows: [{ state: 'QUEUED', payload: { workflowId: 'wf-1', tenantId: 'tenant-a', state: 'QUEUED' } }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ session_id: 'session-1' }], rowCount: 1 },
    { rows: [{ capabilities: [] }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ fencing_token: '7' }], rowCount: 1 }
  ], { workerId: 'worker-1' });
  const lease = await repo.tryAcquire({
    workflowId: 'wf-1',
    leaseId: 'lease-1',
    workerId: 'worker-1',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-a' }
  }, 'tenant-a', { workerPrincipal });
  assert.equal(lease.fencingToken, 7);
  assert.ok(db.calls.some(call => call.text.includes('workflow_dispatch_claims') && call.text.includes('clock_timestamp()')), 'generic lease acquisition must fence active claims');
  const insertCall = db.calls.find(call => call.text.includes('INSERT INTO workflow_leases'));
  assert.ok(insertCall);
  assert.match(insertCall.text, /RETURNING fencing_token/);
});

test('Postgres workflow writes reject stale fencing tokens', async () => {
  const db = fakeDb([
    { rows: [{}], rowCount: 1 },
    { rows: [{ capabilities: [] }], rowCount: 1 },
    { rows: [{ workflow_id: 'wf-1' }], rowCount: 1 },
    { rows: [{}], rowCount: 1 },
    { rows: [{ capabilities: [] }], rowCount: 1 },
    { rows: [], rowCount: 0 }
  ]);
  const repo = new PostgresWorkflowRepository(db);
  const { createWorkerPersistencePrincipal } = require('../../../../src/core/security/worker-persistence-principal');
  const workerPrincipal = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'session-a',
    workflowId: 'wf-1', leaseId: 'lease-stale', fencingToken: 6
  });
  await assert.rejects(
    () => repo.save({
      workflowId: 'wf-1',
      tenantId: 'tenant-a',
      state: 'RUNNING',
      updatedAt: new Date().toISOString(),
      metadata: { fencingToken: 6 },
      toJSON() { return this; }
    }, 'tenant-a', { workerPrincipal }),
    error => error.code === 'WORKFLOW_FENCING_REJECTED'
  );
  assert.match(db.calls[2].text, /FROM workflows/);
  assert.match(db.calls[2].text, /FOR UPDATE/);
  assert.match(db.calls[5].text, /worker_session_id/);
  assert.match(db.calls[5].text, /fencing_token/);
  assert.match(db.calls[5].text, /clock_timestamp/);
});


test('Postgres workflow repair uses tenant-scoped revision compare-and-set', async () => {
  const existing = { workflowId: 'wf-repair', tenantId: 'tenant-a', state: 'WAITING', checkpoint: { revision: 3 } };
  const db = fakeDb([
    { rows: [{ payload: existing }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 1 }
  ]);
  const repo = new PostgresWorkflowRepository(db);
  const repaired = await repo.repair({
    workflowId: 'wf-repair', tenantId: 'tenant-a', state: 'WAITING',
    updatedAt: '2026-11-09T10:00:00.000Z',
    checkpoint: { revision: 3 },
    toJSON() { return this; }
  }, { tenantId: 'tenant-a', expectedRevision: 3, targetRevision: 5 });
  assert.equal(repaired.checkpoint.revision, 5);
  assert.match(db.calls[0].text, /FOR UPDATE/);
  assert.match(db.calls[1].text, /workflow_dispatch_claims/);
  assert.match(db.calls[2].text, /workflow_leases/);
  assert.match(db.calls[3].text, /checkpoint.*revision/);
  assert.deepEqual(db.calls[3].values.slice(0, 2), ['wf-repair', 'tenant-a']);
  assert.equal(db.calls[3].values[5], 3);
});

test('Postgres workflow repair refuses an active dispatch claim before updating', async () => {
  const db = fakeDb([
    { rows: [{ payload: { checkpoint: { revision: 3 } } }], rowCount: 1 },
    { rows: [{}], rowCount: 1 }
  ]);
  const repo = new PostgresWorkflowRepository(db);
  await assert.rejects(
    () => repo.repair({ workflowId: 'wf-claimed', tenantId: 'tenant-a', state: 'WAITING', toJSON() { return this; } },
      { tenantId: 'tenant-a', expectedRevision: 3, targetRevision: 4 }),
    error => error.code === 'WORKFLOW_DISPATCH_CLAIM_HELD'
  );
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[1].text, /workflow_dispatch_claims/);
});

test('Postgres workflow repair rejects stale revisions without writing', async () => {
  const db = fakeDb([{ rows: [{ payload: { checkpoint: { revision: 4 } } }], rowCount: 1 }]);
  const repo = new PostgresWorkflowRepository(db);
  await assert.rejects(
    () => repo.repair({ workflowId: 'wf-stale', tenantId: 'tenant-a', state: 'WAITING', toJSON() { return this; } },
      { tenantId: 'tenant-a', expectedRevision: 3, targetRevision: 5 }),
    error => error.code === 'WORKFLOW_CHECKPOINT_CONFLICT'
  );
  assert.equal(db.calls.length, 1);
});

test('PostgresPersistence exposes durable tenant quota repository', () => {
  const persistence = new PostgresPersistence({ pool: fakeDb() });
  assert.ok(persistence.tenantQuotas);
});

test('Postgres checkpoint repository appends history and returns the latest checkpoint', async () => {
  const crypto = require('crypto');
  const snap1 = { executionId: 'exec-1', tenantId: 'tenant-a' };
  const snap2 = { executionId: 'exec-1', tenantId: 'tenant-a', step: 2 };
  const digest1 = crypto.createHash('sha256').update(JSON.stringify(snap1)).digest('hex');
  const digest2 = crypto.createHash('sha256').update(JSON.stringify(snap2)).digest('hex');
  const row1 = { execution_id:'exec-1',tenant_id:'tenant-a',sequence:'1',checkpoint_id:'cp-1',reason:'step',created_at:new Date().toISOString(),snapshot:snap1,snapshot_sha256:digest1 };
  const row2 = { execution_id:'exec-1',tenant_id:'tenant-a',sequence:'2',checkpoint_id:'cp-2',reason:'step2',created_at:new Date().toISOString(),snapshot:snap2,snapshot_sha256:digest2 };
  const db = fakeDb([
    { rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }, { rows: [{ next_sequence: '1' }], rowCount: 1 }, { rows: [row1], rowCount: 1 },
    { rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }, { rows: [{ next_sequence: '2' }], rowCount: 1 }, { rows: [row2], rowCount: 1 }
  ]);
  const repo = new PostgresCheckpointRepository(db);
  await repo.save(snap1, { tenantId: 'tenant-a' });
  const second = await repo.save(snap2, { tenantId: 'tenant-a' });
  assert.equal(second.sequence, 2);
  assert.match(db.calls[1].text, /pg_advisory_xact_lock/);
  assert.match(db.calls[5].text, /pg_advisory_xact_lock/);
});

test('Postgres tenant quota queues work when the running quota is full', async () => {
  const db = fakeDb([
    { rows: [], rowCount: 1 },
    { rows: [{ max_concurrent: 1, max_queued: 2 }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [{ active: 1, queued: 0 }], rowCount: 1 },
    { rows: [{ tenant_id: 'tenant-a', workflow_id: 'wf-queued', state: 'QUEUED', reserved_at: new Date().toISOString(), expires_at: null }], rowCount: 1 }
  ]);
  const repo = new PostgresTenantQuotaRepository(db);
  const reservation = await repo.reserveWorkflow({
    tenantId: 'tenant-a',
    workflowId: 'wf-queued',
    policy: { maxConcurrent: 1, maxQueued: 2, maxInputChars: 100, maxToolInputChars: 100, maxRetries: 2 }
  });
  assert.equal(reservation.state, 'QUEUED');
  assert.equal(reservation.workflowId, 'wf-queued');
});

test('Postgres tenant quota reservation is atomically admission-controlled', async () => {
  const db = fakeDb([
    { rows: [], rowCount: 1 },
    { rows: [{ max_concurrent: 1, max_queued: 2 }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [{ active: 0, queued: 1 }], rowCount: 1 },
    { rows: [{ tenant_id: 'tenant-a', workflow_id: 'wf-2', state: 'QUEUED', reserved_at: new Date().toISOString(), expires_at: null }], rowCount: 1 }
  ]);
  const repo = new PostgresTenantQuotaRepository(db);
  const reservation = await repo.reserveWorkflow({
    tenantId: 'tenant-a',
    workflowId: 'wf-2',
    policy: { maxConcurrent: 1, maxQueued: 2, maxInputChars: 100, maxToolInputChars: 100, maxRetries: 2 }
  });
  assert.equal(reservation.workflowId, 'wf-2');
  assert.match(db.calls[6].text, /ON CONFLICT\(workflow_id\) DO NOTHING/);
})

test('Postgres execution history uses a tenant-scoped indexed page and count', async () => {
  const db = fakeDb([
    { rows: [{ total: 101 }], rowCount: 1 },
    { rows: [{ payload: { executionId: 'exec-51', status: 'running' } }], rowCount: 1 }
  ]);
  const repo = new PostgresExecutionRepository(db);
  const result = await repo.findPage({ tenantId: 'tenant-a', limit: 50, offset: 50 });
  assert.equal(result.total, 101);
  assert.equal(result.limit, 50);
  assert.equal(result.offset, 50);
  assert.deepEqual(result.executions, [{ executionId: 'exec-51', status: 'running' }]);
  assert.match(db.calls[0].text, /COUNT\(\*\).*WHERE tenant_id=\$1/);
  assert.match(db.calls[1].text, /WHERE tenant_id=\$1 ORDER BY updated_at DESC, execution_id DESC LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(db.calls[1].values, ['tenant-a', 50, 50]);
});

test('Postgres execution event replay queries only the latest bounded tenant-scoped window', async () => {
  const db = fakeDb([{ rows: [{ payload: { id: 'event-200', executionId: 'exec-1' } }], rowCount: 1 }]);
  const repo = new PostgresEventRepository(db);
  const result = await repo.findByExecutionId('exec-1', { tenantId: 'tenant-a', limit: 999 });
  assert.deepEqual(result, [{ id: 'event-200', executionId: 'exec-1' }]);
  assert.match(db.calls[0].text, /WHERE tenant_id=\$1 AND execution_id=\$2 ORDER BY timestamp DESC,event_id DESC LIMIT \$3/);
  assert.match(db.calls[0].text, /ORDER BY timestamp ASC,event_id ASC/);
  assert.deepEqual(db.calls[0].values, ['tenant-a', 'exec-1', 200]);
});

test('Postgres approval repository supports durable tenant-scoped execution and pending queries', async () => {
  const row = {
    approval_id: 'approval-1', execution_id: 'exec-1', step: 2, plan_revision: 1,
    tool: 'files.write', capability: 'filesystem.write', scope: {}, issued_at: '2026-10-10T09:00:00.000Z',
    expires_at: '2026-10-10T11:00:00.000Z', used: false, used_at: null, metadata: { tenantId: 'tenant-a' }, tenant_id: 'tenant-a'
  };
  const db = fakeDb([
    { rows: [row], rowCount: 1 },
    { rows: [row], rowCount: 1 }
  ]);
  const repo = new PostgresApprovalRepository(db);
  const byExecution = await repo.findByExecution({ executionId: 'exec-1', step: 2, tool: 'files.write', planRevision: 1, tenantId: 'tenant-a' });
  assert.equal(byExecution[0].approvalId, 'approval-1');
  assert.equal(byExecution[0].tenantId, 'tenant-a');
  assert.match(db.calls[0].text, /execution_id=\$1 AND tenant_id=\$2 AND step=\$3 AND tool=\$4 AND plan_revision=\$5/);
  assert.deepEqual(db.calls[0].values, ['exec-1', 'tenant-a', 2, 'files.write', 1]);

  const pending = await repo.findPending({ tenantId: 'tenant-a', limit: 10, now: Date.parse('2026-10-10T10:00:00.000Z') });
  assert.equal(pending[0].approvalId, 'approval-1');
  assert.match(db.calls[1].text, /tenant_id=\$1 AND used=FALSE AND expires_at>\$2.*LIMIT \$3/);
  assert.deepEqual(db.calls[1].values, ['tenant-a', '2026-10-10T10:00:00.000Z', 10]);
});


test('Postgres durable-event migration safely handles non-array pending publication JSON', () => {
  const migration = MIGRATIONS.find(item => item.version === 12);
  assert.ok(migration, 'durable-event migration 12 must exist');
  assert.match(migration.sql, /ALTER TABLE events ADD COLUMN IF NOT EXISTS aggregate_id/);
  assert.match(migration.sql, /ALTER TABLE events ADD COLUMN IF NOT EXISTS sequence/);
  assert.match(migration.sql, /CASE\s+WHEN jsonb_typeof\(payload->'metadata'->'pendingPublications'\)='array'/);
  assert.match(migration.sql, /ELSE 0\s+END > 0/);
  assert.doesNotMatch(
    migration.sql,
    /jsonb_array_length\(COALESCE\(payload->'metadata'->'pendingPublications'/
  );
});


test('Postgres mission event append assigns a tenant aggregate sequence and is idempotent', async () => {
  const event = {
    id: 'mission-1', aggregateId: 'workflow-1', executionId: 'workflow-1',
    type: 'workflow.approval.required', timestamp: '2026-11-09T10:00:00.000Z',
    data: { tenantId: 'tenant-a', approvalId: 'approval-1' }
  };
  const persisted = { ...event, sequence: 1 };
  const db = fakeDb([
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [{ next_sequence: '1' }], rowCount: 1 },
    { rows: [{ payload: persisted }], rowCount: 1 }
  ]);
  const repo = new PostgresEventRepository(db);
  const result = await repo.appendMissionEvent(event, { tenantId: 'tenant-a' });
  assert.equal(result.sequence, 1);
  assert.match(db.calls[0].text, /pg_advisory_xact_lock/);
  assert.deepEqual(db.calls[0].values, ['tenant-a', 'workflow-1']);
  assert.match(db.calls[3].text, /aggregate_id,sequence,type/);
});

test('Postgres mission event replay rejects reuse of a stable ID with changed data', async () => {
  const prior = {
    id: 'mission-reused', aggregateId: 'workflow-1', executionId: 'workflow-1',
    type: 'workflow.created', timestamp: '2026-11-09T10:00:00.000Z',
    data: { tenantId: 'tenant-a', value: 'original' }
  };
  const db = fakeDb([
    { rows: [], rowCount: 0 },
    { rows: [{ tenant_id: 'tenant-a', aggregate_id: 'workflow-1', payload: prior }], rowCount: 1 }
  ]);
  const repo = new PostgresEventRepository(db);
  await assert.rejects(
    () => repo.appendMissionEvent({
      ...prior, data: { tenantId: 'tenant-a', value: 'changed' }
    }, { tenantId: 'tenant-a' }),
    error => error.code === 'MISSION_EVENT_ID_CONFLICT'
  );
});

test('Postgres mission event reads are tenant-scoped and sequence-ordered', async () => {
  const events = [{ id: 'mission-1', sequence: 1 }, { id: 'mission-2', sequence: 2 }];
  const db = fakeDb([{ rows: events.map(payload => ({ payload })), rowCount: 2 }]);
  const repo = new PostgresEventRepository(db);
  assert.deepEqual(await repo.findByAggregateId('workflow-1', { tenantId: 'tenant-a' }), events);
  assert.match(db.calls[0].text, /tenant_id=\$1 AND aggregate_id=\$2 ORDER BY sequence ASC/);
  assert.deepEqual(db.calls[0].values, ['tenant-a', 'workflow-1']);
});


test('Postgres generic event append rejects stable ID reuse with changed payload', async () => {
  const prior = {
    id: 'event-reused', type: 'execution.completed', executionId: 'exec-1',
    goalId: null, timestamp: '2026-11-09T10:00:00.000Z',
    data: { tenantId: 'tenant-a', value: 'original' }
  };
  const db = fakeDb([
    { rows: [], rowCount: 0 },
    { rows: [{ tenant_id: 'tenant-a', payload: prior }], rowCount: 1 }
  ]);
  const repo = new PostgresEventRepository(db);
  await assert.rejects(
    () => repo.append({
      ...prior, data: { tenantId: 'tenant-a', value: 'changed' }
    }, { tenantId: 'tenant-a' }),
    error => error.code === 'EVENT_ID_CONFLICT'
  );
});


test('Postgres workflow outbox lookup is bounded, tenant-scoped, and JSON-type safe', async () => {
  const snapshot = {
    workflowId: 'wf-pending', tenantId: 'tenant-a',
    metadata: { approvalBlocked: true, pendingPublications: [{ eventId: 'event-1' }] }
  };
  const db = fakeDb([{ rows: [{ payload: snapshot }], rowCount: 1 }]);
  const repo = new PostgresWorkflowRepository(db);
  assert.deepEqual(await repo.findPendingPublications({ tenantId: 'tenant-a', limit: 8 }), [snapshot]);
  assert.match(db.calls[0].text, /jsonb_typeof\(payload->'metadata'->'pendingPublications'\)/);
  assert.match(db.calls[0].text, /ELSE 0/);
  assert.deepEqual(db.calls[0].values, ['tenant-a', 8]);
});

test('Postgres workflow outbox acknowledgement locks and advances checkpoint revision', async () => {
  const snapshot = {
    workflowId: 'wf-ack', tenantId: 'tenant-a', checkpoint: { revision: 4 },
    metadata: { pendingPublications: [{ eventId: 'event-1' }, { eventId: 'event-2' }] }
  };
  const db = fakeDb([
    { rows: [{ payload: snapshot }], rowCount: 1 },
    { rows: [], rowCount: 1 }
  ]);
  const repo = new PostgresWorkflowRepository(db);
  const result = await repo.acknowledgePendingPublications('wf-ack', 'tenant-a', ['event-1']);
  assert.equal(result.acknowledged, 1);
  assert.equal(result.revision, 5);
  assert.deepEqual(result.pending, [{ eventId: 'event-2' }]);
  assert.match(db.calls[0].text, /FOR UPDATE/);
  assert.match(db.calls[1].text, /UPDATE workflows SET payload=\$3/);
});


test('Postgres mission event append requires the active lease-bound worker principal', async () => {
  const db = fakeDb([
    { rows: [{}], rowCount: 1 },
    { rows: [{ capabilities: [] }], rowCount: 1 },
    { rows: [{ workflow_id: 'workflow-a' }], rowCount: 1 },
    { rows: [{}], rowCount: 1 },
    { rows: [{ capabilities: [] }], rowCount: 1 },
    { rows: [{}], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [{ next_sequence: '1' }], rowCount: 1 },
    { rows: [{ payload: { id: 'worker-event-1', sequence: 1 } }], rowCount: 1 }
  ]);
  const repo = new PostgresEventRepository(db);
  const workerPrincipal = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a',
    workerId: 'worker-a',
    sessionId: 'session-a',
    workflowId: 'workflow-a',
    leaseId: 'lease-a',
    fencingToken: 9
  });
  const result = await repo.appendMissionEvent({
    id: 'worker-event-1',
    aggregateId: 'workflow-a',
    executionId: 'workflow-a',
    type: 'workflow.state.changed',
    timestamp: '2026-11-09T11:00:00.000Z',
    data: { tenantId: 'tenant-a', from: 'QUEUED', to: 'RUNNING' }
  }, { tenantId: 'tenant-a', workerPrincipal });

  assert.equal(result.sequence, 1);
  assert.match(db.calls[0].text, /FROM worker_nodes/);
  assert.match(db.calls[0].text, /session_id/);
  assert.match(db.calls[0].text, /FOR UPDATE/);
  assert.match(db.calls[1].text, /status='READY'/);
  assert.match(db.calls[1].text, /clock_timestamp/);
  assert.match(db.calls[2].text, /FROM workflows/);
  assert.match(db.calls[2].text, /FOR UPDATE/);
  assert.match(db.calls[3].text, /FROM worker_nodes/);
  assert.match(db.calls[3].text, /FOR UPDATE/);
  assert.match(db.calls[4].text, /status='READY'/);
  assert.match(db.calls[4].text, /clock_timestamp/);
  assert.match(db.calls[5].text, /FROM workflow_leases/);
  assert.match(db.calls[5].text, /fencing_token/);
  assert.match(db.calls[5].text, /expires_at > clock_timestamp/);
  assert.match(db.calls[6].text, /pg_advisory_xact_lock/);
});

test('Postgres mission event append rejects a worker principal for another workflow', async () => {
  const db = fakeDb();
  const repo = new PostgresEventRepository(db);
  const workerPrincipal = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a',
    workerId: 'worker-a',
    sessionId: 'session-a',
    workflowId: 'workflow-other',
    leaseId: 'lease-a',
    fencingToken: 9
  });
  await assert.rejects(
    () => repo.appendMissionEvent({
      id: 'worker-event-cross-workflow',
      aggregateId: 'workflow-a',
      executionId: 'workflow-a',
      type: 'workflow.state.changed',
      data: { tenantId: 'tenant-a' }
    }, { tenantId: 'tenant-a', workerPrincipal }),
    error => error.code === 'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.equal(db.calls.length, 0);
});


test('Postgres workflow creation stores the initial snapshot and mission events in one transaction', async () => {
  const calls = [];
  const db = {
    async transaction(work) {
      calls.push('begin');
      const client = { async query(text, values = []) {
        calls.push({ text, values });
        return { rows: [{ workflow_id: 'wf-atomic' }], rowCount: 1 };
      }};
      const result = await work(client);
      calls.push('commit');
      return result;
    }
  };
  const repo = new PostgresWorkflowRepository(db);
  repo.eventRepository = {
    async appendMissionEvent(event, options) {
      assert.ok(options.transactionClient);
      calls.push(['event', event.type]);
      return event;
    }
  };
  const instance = {
    workflowId: 'wf-atomic', tenantId: 'tenant-a', userId: 'owner-a', state: 'QUEUED',
    updatedAt: '2026-11-09T12:00:00.000Z', toJSON() { return this; }
  };
  await repo.createWithEvents(instance, [
    { id: 'evt-created', aggregateId: 'wf-atomic', type: 'workflow.created' },
    { id: 'evt-queued', aggregateId: 'wf-atomic', type: 'workflow.state.changed' }
  ]);
  assert.equal(calls[0], 'begin');
  assert.match(calls[1].text, /INSERT INTO workflows/);
  assert.deepEqual(calls.slice(2), [
    ['event', 'workflow.created'],
    ['event', 'workflow.state.changed'],
    'commit'
  ]);
});

test('Postgres workflow creation rejects an existing workflow ID without overwriting it', async () => {
  const db = fakeDb([{ rows: [], rowCount: 0 }]);
  const repo = new PostgresWorkflowRepository(db);
  repo.eventRepository = { async appendMissionEvent() { throw new Error('must not append'); } };
  await assert.rejects(
    () => repo.createWithEvents({
      workflowId: 'wf-existing', tenantId: 'tenant-a', userId: 'owner-a', state: 'QUEUED',
      toJSON() { return this; }
    }, [{ id: 'evt', aggregateId: 'wf-existing', type: 'workflow.created' }]),
    error => error.code === 'WORKFLOW_ID_CONFLICT'
  );
  assert.equal(db.calls.length, 1);
});


function makeOwnerPrincipal(tenantId, ownerId = 'owner-a') {
  return createPersistencePrincipal({
    tenantId,
    ownerId,
    sessionId: `session-${tenantId}-${ownerId}`
  });
}

test('Postgres principal-scoped reads derive tenant from the validated principal when tenantId is omitted', async () => {
  const principal = makeOwnerPrincipal('local');
  const db = fakeDb();
  const executions = new PostgresExecutionRepository(db);
  const events = new PostgresEventRepository(db);
  const checkpoints = new PostgresCheckpointRepository(db);
  const approvals = new PostgresApprovalRepository(db);

  await executions.findById('exec-local', { persistencePrincipal: principal });
  await executions.findAll({ persistencePrincipal: principal });
  await executions.findPage({ persistencePrincipal: principal, limit: 10 });
  await events.findByExecutionId('exec-local', { persistencePrincipal: principal });
  await checkpoints.findLatest('exec-local', { persistencePrincipal: principal });
  await approvals.findByExecution({ executionId: 'exec-local', persistencePrincipal: principal });
  await approvals.findPending({ persistencePrincipal: principal, limit: 10 });
  await approvals.findById('approval-local', { persistencePrincipal: principal });
  await approvals.consume('approval-local', '2026-11-10T00:00:00.000Z', null, { persistencePrincipal: principal });
  await assert.rejects(
    approvals.recordDecision(
      'approval-local',
      { status: 'approved', actorId: principal.sessionId, decidedAt: '2026-11-10T00:00:00.000Z' },
      null,
      () => Date.parse('2026-11-10T00:00:00.000Z'),
      principal
    ),
    error => error.code === 'APPROVAL_NOT_FOUND'
  );

  assert.equal(db.calls.length, 11);
  for (const [index, call] of db.calls.entries()) {
    assert.ok(call.values.includes('local'), `query ${index + 1} must bind the principal tenant`);
    assert.match(call.text, /tenant_id=\$\d+/, `query ${index + 1} must constrain tenant_id`);
  }
  assert.deepEqual(db.calls[0].values, ['exec-local', 'local', 'owner-a']);
  assert.deepEqual(db.calls[1].values, ['local', 'owner-a']);
  assert.deepEqual(db.calls[2].values, ['local', 'owner-a']);
  assert.deepEqual(db.calls[3].values, ['local', 'owner-a', 10, 0]);
  assert.deepEqual(db.calls[4].values, ['local', 'exec-local', 'owner-a']);
  assert.deepEqual(db.calls[5].values, ['exec-local', 'local', 'owner-a']);
  assert.deepEqual(db.calls[6].values, ['exec-local', 'local', 'owner-a']);
  assert.deepEqual(db.calls[7].values.slice(1, 3), ['local', 'owner-a']);
  assert.deepEqual(db.calls[8].values, ['approval-local', 'local', 'owner-a']);
  assert.deepEqual(db.calls[9].values, ['2026-11-10T00:00:00.000Z', 'approval-local', 'local', 'owner-a']);
  assert.deepEqual(db.calls[10].values, ['approval-local', 'local', 'owner-a']);
});

test('Postgres principal-scoped reads derive a non-local tenant and reject an explicit tenant mismatch', async () => {
  const principal = makeOwnerPrincipal('tenant-a');
  const db = fakeDb();
  const executions = new PostgresExecutionRepository(db);

  await executions.findAll({ persistencePrincipal: principal });
  assert.deepEqual(db.calls[0].values, ['tenant-a', 'owner-a']);
  assert.match(db.calls[0].text, /WHERE tenant_id=\$1 AND payload->>'userId'=\$2/);

  await assert.rejects(
    executions.findById('exec-other', { tenantId: 'tenant-b', persistencePrincipal: principal }),
    error => error.code === 'TENANT_PERSISTENCE_MISMATCH'
  );
  assert.equal(db.calls.length, 1, 'a mismatched explicit tenant must fail before issuing SQL');
});
