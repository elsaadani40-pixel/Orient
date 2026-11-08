'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PostgresWorkerRegistryRepository = require('../../../../src/infrastructure/persistence/postgres/postgres-worker-registry-repository');
const { createWorkerPersistencePrincipal } = require('../../../../src/core/security/worker-persistence-principal');

function principal(overrides = {}) {
  return createWorkerPersistencePrincipal({
    tenantId: 'tenant-a',
    workerId: 'worker-a',
    sessionId: 'session-a',
    capabilities: ['runtime'],
    ...overrides
  });
}

function fakeDb({ insertRows = null, updateRows = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith('INSERT INTO worker_nodes')) {
        return { rows: insertRows || [{
          tenant_id: values[0], worker_id: values[1], started_at: values[2],
          heartbeat_at: values[3], expires_at: values[4], status: values[5],
          capabilities: JSON.parse(values[6]), metadata: values[7], session_id: values[8]
        }], rowCount: insertRows ? insertRows.length : 1 };
      }
      if (sql.startsWith('UPDATE worker_nodes')) return { rows: updateRows || [], rowCount: updateRows ? updateRows.length : 0 };
      if (sql.startsWith('DELETE FROM worker_nodes')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM worker_nodes')) return { rows: [] };
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '0' }] };
      return { rows: [], rowCount: 0 };
    }
  };
  let transactions = 0;
  return {
    calls,
    client,
    get transactions() { return transactions; },
    async transactionWithWorkerPrincipal(identity, work) {
      transactions += 1;
      assert.equal(identity.kind, 'worker');
      return work(client, identity);
    },
    async query(sql, values) { calls.push({ sql, values }); return { rows: [], rowCount: 1 }; }
  };
}

test('worker registry persists registration bound to the trusted worker session', async () => {
  const db = fakeDb();
  const repo = new PostgresWorkerRegistryRepository(db);
  const identity = principal();
  const result = await repo.register({
    workerId: 'worker-a',
    tenantId: 'tenant-a',
    startedAt: '2026-10-07T06:00:00.000Z',
    heartbeatAt: '2026-10-07T06:00:00.000Z',
    expiresAt: '2026-10-07T06:00:30.000Z',
    capabilities: ['runtime'],
    metadata: { zone: 'a' }
  }, 'tenant-a', { workerPrincipal: identity });

  assert.equal(result.workerId, 'worker-a');
  assert.equal(result.tenantId, 'tenant-a');
  assert.equal(result.sessionId, 'session-a');
  assert.match(db.calls[0].sql, /session_id/);
  assert.match(db.calls[0].sql, /worker_nodes\.session_id=EXCLUDED\.session_id/);
  assert.deepEqual(db.calls[0].values.slice(0, 2), ['tenant-a', 'worker-a']);
  assert.equal(db.calls[0].values[8], 'session-a');
  assert.equal(db.transactions, 1);
});

test('worker registry rejects cross-tenant or cross-worker principals before SQL', async () => {
  const db = fakeDb();
  const repo = new PostgresWorkerRegistryRepository(db);
  await assert.rejects(
    () => repo.register({ workerId: 'worker-a', tenantId: 'tenant-a' }, 'tenant-b', {
      workerPrincipal: principal()
    }),
    error => error.code === 'TENANT_PERSISTENCE_MISMATCH'
  );
  await assert.rejects(
    () => repo.register({ workerId: 'worker-b', tenantId: 'tenant-a' }, 'tenant-a', {
      workerPrincipal: principal()
    }),
    error => error.code === 'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.equal(db.calls.length, 0);
});

test('worker registry heartbeat and unregister require the exact active worker session', async () => {
  const db = fakeDb();
  const repo = new PostgresWorkerRegistryRepository(db);
  await assert.rejects(
    () => repo.heartbeat('missing', { tenantId: 'tenant-a', workerPrincipal: principal() }),
    error => error.code === 'WORKER_SESSION_LOST'
  );
  assert.match(db.calls[0].sql, /session_id=\$6 AND expires_at > NOW\(\)/);

  const removed = await repo.unregister('worker-a', 'tenant-a', { workerPrincipal: principal() });
  assert.equal(removed, true);
  assert.match(db.calls[1].sql, /session_id=\$3/);
  assert.equal(db.transactions, 2);
});

test('worker registry rejects stale-session replacement while a prior session is live', async () => {
  const db = fakeDb({ insertRows: [] });
  const repo = new PostgresWorkerRegistryRepository(db);
  await assert.rejects(
    () => repo.register({ workerId: 'worker-a', tenantId: 'tenant-a' }, 'tenant-a', {
      workerPrincipal: principal({ sessionId: 'new-session' })
    }),
    error => error.code === 'WORKER_SESSION_CONFLICT'
  );
  assert.equal(db.transactions, 1);
});

test('worker registry can reap expired workers only inside the tenant boundary', async () => {
  const db = fakeDb();
  const repo = new PostgresWorkerRegistryRepository(db);
  const count = await repo.reapExpired({ tenantId: 'tenant-a', now: '2026-10-07T06:01:00.000Z' });
  assert.equal(count, 1);
  assert.match(db.calls[0].sql, /WHERE tenant_id=\$1 AND expires_at <= \$2/);
  assert.deepEqual(db.calls[0].values, ['tenant-a', '2026-10-07T06:01:00.000Z']);
});
