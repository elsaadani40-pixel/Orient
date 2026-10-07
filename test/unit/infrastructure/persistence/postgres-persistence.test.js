const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PostgresPersistence,
  PostgresEventRepository,
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
  const db = fakeDb([{ rows: [], rowCount: 0 }, { rows: [{ fencing_token: '7' }], rowCount: 1 }]);
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
  assert.match(db.calls[1].text, /RETURNING fencing_token/);
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
  const snap1 = { executionId: 'exec-1' };
  const snap2 = { executionId: 'exec-1', step: 2 };
  const digest1 = crypto.createHash('sha256').update(JSON.stringify(snap1)).digest('hex');
  const digest2 = crypto.createHash('sha256').update(JSON.stringify(snap2)).digest('hex');
  const db = fakeDb([
    { rows: [], rowCount: 0 }, { rows: [{ next_sequence: '1' }], rowCount: 1 }, { rows: [{ execution_id:'exec-1',tenant_id:'tenant-a',sequence:'1',checkpoint_id:'cp-1',reason:'step',created_at:new Date().toISOString(),snapshot:snap1,snapshot_sha256:digest1 }], rowCount:1 },
    { rows: [], rowCount: 0 }, { rows: [{ next_sequence: '2' }], rowCount: 1 }, { rows: [{ execution_id:'exec-1',tenant_id:'tenant-a',sequence:'2',checkpoint_id:'cp-2',reason:'step2',created_at:new Date().toISOString(),snapshot:snap2,snapshot_sha256:digest2 }], rowCount:1 }
  ]);
  const repo = new PostgresCheckpointRepository(db);
  await repo.save(snap1, { tenantId: 'tenant-a' });
  const second = await repo.save(snap2, { tenantId: 'tenant-a' });
  assert.equal(second.sequence, 2);
  assert.match(db.calls[1].text, /pg_advisory_xact_lock/);
  assert.match(db.calls[4].text, /pg_advisory_xact_lock/);
});

test('Postgres tenant quota reservation is atomically admission-controlled', async () => {
  const db = fakeDb([
    { rows: [], rowCount: 1 },
    { rows: [{ max_concurrent: 1, max_queued: 2 }], rowCount: 1 },
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
  assert.match(db.calls[5].text, /ON CONFLICT\\(workflow_id\\) DO NOTHING/);
})