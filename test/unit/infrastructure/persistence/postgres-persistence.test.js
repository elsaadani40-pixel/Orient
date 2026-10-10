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

function fakeDb(responses = []) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      return responses.shift() || { rows: [], rowCount: 0 };
    },
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


test('Postgres workflow lease acquisition returns a durable fencing token', async () => {
  const db = fakeDb([{ rows: [{ state: 'QUEUED', payload: { workflowId: 'wf-1', tenantId: 'tenant-a', state: 'QUEUED' } }], rowCount: 1 }, { rows: [], rowCount: 0 }, { rows: [{ fencing_token: '7' }], rowCount: 1 }]);
  const repo = new PostgresWorkflowLeaseRepository(db);
  const lease = await repo.tryAcquire({
    workflowId: 'wf-1',
    leaseId: 'lease-1',
    workerId: 'worker-1',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-a' }
  }, 'tenant-a');
  assert.equal(lease.fencingToken, 7);
  const insertCall = db.calls.find(call => call.text.includes('INSERT INTO workflow_leases'));
  assert.ok(insertCall);
  assert.match(insertCall.text, /RETURNING fencing_token/);
});

test('Postgres workflow writes reject stale fencing tokens', async () => {
  const db = fakeDb([{ rows: [], rowCount: 0 }]);
  const repo = new PostgresWorkflowRepository(db);
  await assert.rejects(
    () => repo.save({
      workflowId: 'wf-1',
      tenantId: 'tenant-a',
      state: 'RUNNING',
      updatedAt: new Date().toISOString(),
      metadata: { fencingToken: 6 },
      toJSON() { return this; }
    }, 'tenant-a'),
    error => error.code === 'WORKFLOW_FENCING_REJECTED'
  );
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


test('Postgres approval consume requires an approved decision and checks expiry in SQL', async () => {
  const now = Date.now();
  const db = fakeDb([{ rows: [], rowCount: 1 }]);
  const repo = new PostgresApprovalRepository(db);
  const requestedAt = new Date(now + 10).toISOString();
  const consumed = await repo.consume('approval-consume-pg', requestedAt, 'tenant-a', () => now);
  assert.equal(consumed, true);
  assert.ok(db.calls[0].text.includes("metadata->'decision'->>'status'='approved'"));
  assert.ok(db.calls[0].text.includes('clock_timestamp()'));
  assert.ok(db.calls[0].text.includes('expires_at>$1::timestamptz'));
  assert.deepEqual(db.calls[0].values, [
    requestedAt,
    new Date(now).toISOString(),
    'approval-consume-pg',
    'tenant-a'
  ]);
});


test('Postgres approval decisions evaluate expiry through the injected clock and SQL commit guard', async () => {
  const now = Date.now();
  const expiresAt = new Date(now + 60000).toISOString();
  const row = {
    approval_id: 'approval-decision-pg',
    execution_id: 'exec-pg',
    step: 1,
    plan_revision: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: {},
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: expiresAt,
    used: false,
    used_at: null,
    metadata: { tenantId: 'tenant-a' },
    tenant_id: 'tenant-a'
  };
  const decision = { status: 'approved', actorId: 'owner-a', decidedAt: new Date(now).toISOString() };
  const updated = { ...row, metadata: { ...row.metadata, decision } };
  const db = fakeDb([
    { rows: [row], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [updated], rowCount: 1 }
  ]);
  const repo = new PostgresApprovalRepository(db);
  const result = await repo.recordDecision('approval-decision-pg', decision, 'tenant-a', () => now);
  assert.equal(result.decision.status, 'approved');
  assert.ok(db.calls[1].text.includes('expires_at>clock_timestamp()'));
  assert.equal(db.calls[1].values[1], new Date(now).toISOString());

  const expiredDb = fakeDb([{ rows: [row], rowCount: 1 }]);
  const expiredRepo = new PostgresApprovalRepository(expiredDb);
  await assert.rejects(
    () => expiredRepo.recordDecision('approval-decision-pg', decision, 'tenant-a', () => Date.parse(expiresAt)),
    error => error.code === 'APPROVAL_EXPIRED'
  );
  assert.equal(expiredDb.calls.length, 1);
});
