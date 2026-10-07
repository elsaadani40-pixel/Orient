const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PostgresPersistence,
  PostgresEventRepository,
  PostgresIdempotencyRepository,
  PostgresWorkflowLeaseRepository,
  PostgresWorkflowRepository
} = require('../../../../src/infrastructure/persistence/postgres/postgres-persistence');

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
  assert.match(db.calls[0].text, /ON CONFLICT\(key\) DO NOTHING/);
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
