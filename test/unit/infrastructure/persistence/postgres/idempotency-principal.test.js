'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresIdempotencyRepository } = require('../../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const { createPersistencePrincipal } = require('../../../../../src/core/security/persistence-principal');

function createHarness() {
  const calls = [];
  const records = new Map();
  let transactions = 0;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith('INSERT INTO idempotency')) {
        const [key, tenantId, payload] = values;
        const mapKey = tenantId + ':' + key;
        if (records.has(mapKey)) return { rows: [], rowCount: 0 };
        records.set(mapKey, payload);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT payload FROM idempotency')) {
        const record = records.get(values[1] + ':' + values[0]);
        return { rows: record ? [{ payload: { ...record } }] : [], rowCount: record ? 1 : 0 };
      }
      if (sql.startsWith('UPDATE idempotency')) {
        const [key, tenantId, payload] = values;
        const mapKey = tenantId + ':' + key;
        if (!records.has(mapKey)) return { rows: [], rowCount: 0 };
        records.set(mapKey, payload);
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const db = {
    query() { throw new Error('Pool-level query must not be used for principal-scoped idempotency'); },
    async transactionWithPrincipal(principal, work) {
      transactions += 1;
      assert.equal(principal.tenantId, 'tenant-a');
      return work(client, principal);
    }
  };
  return { db, calls, records, get transactions() { return transactions; } };
}

const principal = () => createPersistencePrincipal({
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  sessionId: 'session-a'
});

const operation = () => ({
  executionId: 'execution-a',
  step: 1,
  tool: 'api.v1.tasks.create',
  operationId: 'task-create-key',
  tenantId: 'tenant-a'
});

test('owner-scoped task idempotency begin, complete and fail use principal transaction clients', async () => {
  const harness = createHarness();
  const repository = new PostgresIdempotencyRepository(harness.db);
  const identity = principal();

  const begun = await repository.begin({ ...operation(), persistencePrincipal: identity });
  assert.equal(begun.created, true);
  assert.equal(begun.record.status, 'running');

  const completed = await repository.complete(begun.key, { id: 'task-a' }, {
    tenantId: 'tenant-a',
    persistencePrincipal: identity
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { id: 'task-a' });

  const failedBegin = await repository.begin({
    ...operation(),
    executionId: 'execution-b',
    operationId: 'task-fail-key',
    persistencePrincipal: identity
  });
  const failed = await repository.fail(failedBegin.key, { code: 'TEST_FAILURE' }, {
    tenantId: 'tenant-a',
    persistencePrincipal: identity
  });
  assert.equal(failed.status, 'failed');
  assert.equal(harness.transactions, 4);
  assert.equal(harness.calls.some(call => call.sql.startsWith('INSERT INTO idempotency')), true);
  assert.equal(harness.calls.some(call => call.sql.startsWith('UPDATE idempotency')), true);
});

test('owner-scoped idempotency rejects tenant mismatch before opening a principal transaction', async () => {
  const harness = createHarness();
  const repository = new PostgresIdempotencyRepository(harness.db);
  await assert.rejects(
    () => repository.begin({
      ...operation(),
      tenantId: 'tenant-b',
      persistencePrincipal: principal()
    }),
    error => error.code === 'TENANT_PERSISTENCE_MISMATCH'
  );
  assert.equal(harness.transactions, 0);
  assert.equal(harness.calls.length, 0);
});

test('unissued principal is rejected before any SQL is executed', async () => {
  const harness = createHarness();
  const repository = new PostgresIdempotencyRepository(harness.db);
  await assert.rejects(
    () => repository.begin({
      ...operation(),
      persistencePrincipal: {
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
        sessionId: 'session-a'
      }
    }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_REQUIRED'
  );
  assert.equal(harness.transactions, 0);
  assert.equal(harness.calls.length, 0);
});
