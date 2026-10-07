const test = require('node:test');
const assert = require('node:assert/strict');
const PostgresWorkerRegistryRepository = require('../../../../src/infrastructure/persistence/postgres/postgres-worker-registry-repository');

function fakeDb() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT * FROM worker_nodes')) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '0' }] };
      return { rowCount: 1, rows: [] };
    }
  };
}

test('worker registry persists tenant-scoped worker registration', async () => {
  const db = fakeDb();
  const repo = new PostgresWorkerRegistryRepository(db);
  const result = await repo.register({
    workerId: 'worker-a',
    tenantId: 'tenant-a',
    startedAt: '2026-10-07T06:00:00.000Z',
    heartbeatAt: '2026-10-07T06:00:00.000Z',
    expiresAt: '2026-10-07T06:00:30.000Z',
    capabilities: ['runtime'],
    metadata: { zone: 'a' }
  }, 'tenant-a');

  assert.equal(result.workerId, 'worker-a');
  assert.equal(result.tenantId, 'tenant-a');
  assert.match(db.calls[0].sql, /ON CONFLICT\(tenant_id,worker_id\)/);
  assert.deepEqual(db.calls[0].values.slice(0, 2), ['tenant-a', 'worker-a']);
});

test('worker registry rejects cross-tenant registration', async () => {
  const repo = new PostgresWorkerRegistryRepository(fakeDb());
  await assert.rejects(
    () => repo.register({ workerId: 'worker-a', tenantId: 'tenant-a' }, 'tenant-b'),
    error => error.code === 'TENANT_PERSISTENCE_MISMATCH'
  );
});

test('worker registry heartbeat requires an existing worker', async () => {
  const db = fakeDb();
  db.query = async (sql, values) => {
    db.calls.push({ sql, values });
    if (sql.startsWith('UPDATE worker_nodes')) return { rowCount: 0, rows: [] };
    return { rows: [] };
  };
  const repo = new PostgresWorkerRegistryRepository(db);
  await assert.rejects(
    () => repo.heartbeat('missing', { tenantId: 'tenant-a' }),
    error => error.code === 'WORKER_NOT_REGISTERED'
  );
});

test('worker registry can reap expired workers only inside the tenant boundary', async () => {
  const db = fakeDb();
  const repo = new PostgresWorkerRegistryRepository(db);
  const count = await repo.reapExpired({ tenantId: 'tenant-a', now: '2026-10-07T06:01:00.000Z' });
  assert.equal(count, 1);
  assert.match(db.calls[0].sql, /WHERE tenant_id=\$1 AND expires_at <= \$2/);
  assert.deepEqual(db.calls[0].values, ['tenant-a', '2026-10-07T06:01:00.000Z']);
});
