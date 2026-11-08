'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PostgresExecutionRepository,
  PostgresEventRepository
} = require('../../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const { createPersistencePrincipal } = require('../../../../../src/core/security/persistence-principal');

function createHarness() {
  const calls = [];
  let transactionCount = 0;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: '1' }], rowCount: 1 };
      if (sql.includes('FROM executions') && sql.includes('payload')) {
        const owner = values.find(value => value === 'owner-a' || value === 'owner-b');
        if (sql.includes('payload->>\\'userId\\'=$')) {
          return {
            rows: owner === 'owner-a'
              ? [{ payload: { executionId: 'exec-a', userId: 'owner-a' } }]
              : [],
            rowCount: owner === 'owner-a' ? 1 : 0
          };
        }
        return { rows: [{ payload: { executionId: 'exec-a', userId: 'owner-a' } }], rowCount: 1 };
      }
      if (sql.includes('FROM events')) {
        const owner = values.find(value => value === 'owner-a' || value === 'owner-b');
        return {
          rows: owner === 'owner-a' ? [{ payload: { id: 'event-a', executionId: 'exec-a' } }] : [],
          rowCount: owner === 'owner-a' ? 1 : 0
        };
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const db = {
    query() { throw new Error('Principal-scoped reads must use the checked-out transaction client'); },
    async transactionWithPrincipal(principal, work) {
      transactionCount += 1;
      assert.equal(principal.tenantId, 'tenant-a');
      return work(client, principal);
    }
  };
  return { db, calls, get transactionCount() { return transactionCount; } };
}

function principal(ownerId) {
  return createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId,
    sessionId: 'session-' + ownerId
  });
}

test('execution status lookup is scoped to the authenticated owner in a principal transaction', async () => {
  const harness = createHarness();
  const repository = new PostgresExecutionRepository(harness.db);

  const visible = await repository.findById('exec-a', {
    tenantId: 'tenant-a',
    persistencePrincipal: principal('owner-a')
  });
  const hidden = await repository.findById('exec-a', {
    tenantId: 'tenant-a',
    persistencePrincipal: principal('owner-b')
  });

  assert.equal(visible.userId, 'owner-a');
  assert.equal(hidden, null);
  assert.equal(harness.transactionCount, 2);
  assert.ok(harness.calls.every(call => call.sql.includes("payload->>'userId'")));
});

test('execution pagination scopes both count and page to the authenticated owner', async () => {
  const harness = createHarness();
  const repository = new PostgresExecutionRepository(harness.db);
  const page = await repository.findPage({
    tenantId: 'tenant-a',
    limit: 10,
    offset: 0,
    persistencePrincipal: principal('owner-a')
  });

  assert.equal(page.total, 1);
  assert.equal(page.executions[0].userId, 'owner-a');
  assert.equal(harness.transactionCount, 1);
  assert.equal(harness.calls.length, 2);
  assert.ok(harness.calls.every(call => call.values.includes('owner-a')));
});

test('event history requires an execution owned by the authenticated principal', async () => {
  const harness = createHarness();
  const repository = new PostgresEventRepository(harness.db);
  const visible = await repository.findByExecutionId('exec-a', {
    tenantId: 'tenant-a',
    limit: 20,
    persistencePrincipal: principal('owner-a')
  });
  const hidden = await repository.findByExecutionId('exec-a', {
    tenantId: 'tenant-a',
    limit: 20,
    persistencePrincipal: principal('owner-b')
  });

  assert.equal(visible.length, 1);
  assert.equal(hidden.length, 0);
  assert.equal(harness.transactionCount, 2);
  assert.ok(harness.calls.every(call => call.sql.includes('EXISTS (SELECT 1 FROM executions')));
});
