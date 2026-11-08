'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPersistencePrincipal,
  assertPersistencePrincipal
} = require('../../../../src/infrastructure/persistence/postgres/persistence-principal');
const { PostgresDatabase } = require('../../../../src/infrastructure/persistence/postgres/postgres-database');

function createPoolHarness({ failAt = null } = {}) {
  const calls = [];
  let released = 0;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (failAt && sql === failAt) throw new Error('injected database failure');
      return { rows: [], rowCount: 0 };
    },
    release() { released += 1; }
  };
  return {
    calls,
    get released() { return released; },
    pool: {
      query() { throw new Error('pool.query must not be used inside a principal transaction'); },
      async connect() { return client; }
    }
  };
}

test('persistence principal validates required identifiers and is immutable', () => {
  assert.throws(() => createPersistencePrincipal({ tenantId: 'tenant-a', ownerId: 'owner-a' }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_INVALID');
  assert.throws(() => createPersistencePrincipal({ tenantId: ' ', ownerId: 'owner-a', sessionId: 'session-a' }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_INVALID');

  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    sessionId: 'session-a'
  });
  assert.equal(Object.isFrozen(principal), true);
  assert.equal(principal.tenantId, 'tenant-a');
  assert.throws(() => { principal.tenantId = 'tenant-b'; }, TypeError);
  assert.throws(() => assertPersistencePrincipal({ ...principal }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_REQUIRED');
  assert.equal(assertPersistencePrincipal(principal), principal);
});

test('principal transaction sets tenant, owner and session locally on the checked-out client', async () => {
  const harness = createPoolHarness();
  const db = new PostgresDatabase({ pool: harness.pool });
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a'
  });
  const result = await db.transactionWithPrincipal(principal, async (client, received) => {
    assert.equal(received, principal);
    await client.query('SELECT protected_operation()');
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.equal(harness.calls[0].sql, 'BEGIN');
  assert.match(harness.calls[1].sql, /set_config\('app\.orient_tenant_id', \$1, true\)/);
  assert.match(harness.calls[1].sql, /set_config\('app\.orient_owner_id', \$2, true\)/);
  assert.match(harness.calls[1].sql, /set_config\('app\.orient_session_id', \$3, true\)/);
  assert.deepEqual(harness.calls[1].values, ['tenant-a', 'owner-a', 'session-a']);
  assert.equal(harness.calls[2].sql, 'SELECT protected_operation()');
  assert.equal(harness.calls[3].sql, 'COMMIT');
  assert.equal(harness.released, 1);
});

test('principal transaction rolls back and releases the client when work fails', async () => {
  const harness = createPoolHarness();
  const db = new PostgresDatabase({ pool: harness.pool });
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a'
  });

  await assert.rejects(
    () => db.transactionWithPrincipal(principal, async client => {
      await client.query('SELECT protected_operation()');
      throw new Error('operation failed');
    }),
    /operation failed/
  );
  assert.equal(harness.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(harness.released, 1);
});

test('principal transaction rejects unissued identity before acquiring a connection', async () => {
  let connects = 0;
  const db = new PostgresDatabase({
    pool: { query() {}, async connect() { connects += 1; throw new Error('unexpected connect'); } }
  });
  await assert.rejects(
    () => db.transactionWithPrincipal({ tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' }, async () => {}),
    error => error.code === 'PERSISTENCE_PRINCIPAL_REQUIRED'
  );
  assert.equal(connects, 0);
});
