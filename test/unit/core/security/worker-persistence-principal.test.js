'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWorkerPersistencePrincipal,
  assertWorkerPersistencePrincipal
} = require('../../../src/core/security/worker-persistence-principal');
const { PostgresDatabase } = require('../../../src/infrastructure/persistence/postgres/postgres-database');

function makePool() {
  const calls = [];
  let released = 0;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    release() { released += 1; }
  };
  return {
    calls,
    get released() { return released; },
    async connect() { return client; },
    async query() { throw new Error('Worker transaction must use its checked-out client'); }
  };
}

test('worker persistence principals are immutable, typed, and lease bindings are all-or-nothing', () => {
  const principal = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a',
    workerId: 'worker-a',
    sessionId: 'boot-a',
    capabilities: ['browser', 'memory.read', 'browser']
  });
  assert.equal(principal.kind, 'worker');
  assert.deepEqual(principal.capabilities, ['browser', 'memory.read']);
  assert.ok(Object.isFrozen(principal));
  assert.ok(Object.isFrozen(principal.capabilities));
  assert.equal(assertWorkerPersistencePrincipal(principal), principal);
  assert.throws(
    () => assertWorkerPersistencePrincipal({ ...principal }),
    error => error.code === 'WORKER_PERSISTENCE_PRINCIPAL_REQUIRED'
  );
  assert.throws(
    () => createWorkerPersistencePrincipal({
      tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'boot-a', workflowId: 'workflow-a'
    }),
    error => error.code === 'WORKER_PERSISTENCE_LEASE_BINDING_INVALID'
  );
  assert.throws(
    () => assertWorkerPersistencePrincipal(principal, { requireLease: true }),
    error => error.code === 'WORKER_PERSISTENCE_LEASE_REQUIRED'
  );
});

test('worker principal transaction binds tenant, worker session, capabilities, and lease to one checked-out client', async () => {
  const pool = makePool();
  const db = new PostgresDatabase({ pool });
  const principal = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a',
    workerId: 'worker-a',
    sessionId: 'boot-a',
    capabilities: ['memory.read', 'browser'],
    workflowId: 'workflow-a',
    leaseId: 'lease-a',
    fencingToken: 7
  });
  const result = await db.transactionWithWorkerPrincipal(principal, async (client, identity) => {
    assert.equal(identity, principal);
    assert.equal(client, await pool.connect());
    return 'committed';
  }, { requireLease: true });

  assert.equal(result, 'committed');
  assert.equal(pool.released, 1);
  assert.equal(pool.calls[0].sql, 'BEGIN');
  assert.match(pool.calls[1].sql, /app\.orient_worker_id/);
  assert.deepEqual(pool.calls[1].values, [
    'tenant-a',
    'worker-a',
    'boot-a',
    JSON.stringify(['browser', 'memory.read']),
    'workflow-a',
    'lease-a',
    '7'
  ]);
  assert.equal(pool.calls[2].sql, 'COMMIT');
});

test('worker principal transaction rolls back and releases the client when work fails', async () => {
  const pool = makePool();
  const db = new PostgresDatabase({ pool });
  const principal = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a',
    workerId: 'worker-a',
    sessionId: 'boot-a'
  });
  await assert.rejects(
    db.transactionWithWorkerPrincipal(principal, async () => {
      throw new Error('simulated worker repository failure');
    }),
    /simulated worker repository failure/
  );
  assert.equal(pool.released, 1);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});
