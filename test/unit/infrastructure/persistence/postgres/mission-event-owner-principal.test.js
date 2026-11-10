'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresEventRepository } = require('../../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const { createPersistencePrincipal } = require('../../../../../src/core/security/persistence-principal');

test('owner mission-event append verifies workflow ownership and uses a principal transaction', async () => {
  const principal = createPersistencePrincipal({ tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' });
  const calls = [];
  const responses = [
    { rows: [{ ok: 1 }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ next_sequence: '1' }], rowCount: 1 },
    { rows: [{ payload: { id: 'event-owner-1', sequence: 1 } }], rowCount: 1 }
  ];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return responses.shift() || { rows: [], rowCount: 0 };
    }
  };
  let transactions = 0;
  const db = {
    async transactionWithPrincipal(received, work) {
      transactions += 1;
      assert.strictEqual(received, principal);
      return work(client);
    },
    async transaction() { throw new Error('Owner event writes require principal transaction'); }
  };
  const repository = new PostgresEventRepository(db);
  await repository.appendMissionEvent({
    id: 'event-owner-1',
    aggregateId: 'workflow-owner-1',
    executionId: 'workflow-owner-1',
    type: 'workflow.snapshot.replaced',
    timestamp: '2026-11-09T10:00:00.000Z',
    data: { tenantId: 'tenant-a', snapshot: { userId: 'owner-a' } }
  }, { tenantId: 'tenant-a', persistencePrincipal: principal });

  assert.equal(transactions, 1);
  assert.match(calls[0].sql, /payload->>'userId'=\$3/);
  assert.match(calls[1].sql, /workflow_dispatch_claims/);
  assert.match(calls[2].sql, /workflow_leases/);
  assert.match(calls[3].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].values, ['workflow-owner-1', 'tenant-a', 'owner-a']);
});

test('owner mission-event append rejects a tenant mismatch before opening a transaction', async () => {
  const principal = createPersistencePrincipal({ tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' });
  let transactions = 0;
  const repository = new PostgresEventRepository({
    async transactionWithPrincipal() { transactions += 1; },
    async transaction() { transactions += 1; }
  });
  await assert.rejects(
    repository.appendMissionEvent({
      id: 'event-owner-mismatch',
      aggregateId: 'workflow-owner-1',
      type: 'workflow.snapshot.replaced',
      data: { tenantId: 'tenant-b' }
    }, { tenantId: 'tenant-b', persistencePrincipal: principal }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.equal(transactions, 0);
});
