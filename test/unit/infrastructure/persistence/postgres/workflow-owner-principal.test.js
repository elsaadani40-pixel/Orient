'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresWorkflowRepository } = require('../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const { createPersistencePrincipal } = require('../../../../src/core/security/persistence-principal');

function fixture(responses = []) {
  const calls = [];
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a'
  });
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return responses.shift() || { rows: [], rowCount: 0 };
    }
  };
  let transactions = 0;
  const db = {
    async query() { throw new Error('Owner-scoped workflow access must use a principal transaction'); },
    async transactionWithPrincipal(received, work) {
      transactions += 1;
      assert.strictEqual(received, principal);
      return work(client);
    }
  };
  const repo = new PostgresWorkflowRepository(db);
  const instance = {
    workflowId: 'workflow-a', tenantId: 'tenant-a', userId: 'owner-a',
    state: 'WAITING', updatedAt: new Date().toISOString(), metadata: {},
    toJSON() { return { ...this }; }
  };
  return { repo, principal, instance, calls, get transactions() { return transactions; } };
}

test('owner-scoped workflow creation is bound to the trusted principal and tenant', async () => {
  const h = fixture([{ rows: [], rowCount: 0 }, { rows: [{ workflow_id: 'workflow-a' }], rowCount: 1 }]);
  await h.repo.save(h.instance, 'tenant-a', { persistencePrincipal: h.principal });
  assert.equal(h.transactions, 1);
  assert.match(h.calls[0].sql, /payload->>'userId'=\$3/);
  assert.match(h.calls[1].sql, /INSERT INTO workflows/);
  assert.deepEqual(h.calls[1].values.slice(0, 2), ['workflow-a', 'tenant-a']);
});

test('owner-scoped workflow update rejects active worker leases and writes by owner predicate', async () => {
  const h = fixture([
    { rows: [{ workflow_id: 'workflow-a' }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ workflow_id: 'workflow-a' }], rowCount: 1 }
  ]);
  await h.repo.save(h.instance, 'tenant-a', { persistencePrincipal: h.principal });
  assert.match(h.calls[0].sql, /payload->>'userId'/);
  assert.match(h.calls[1].sql, /workflow_leases/);
  assert.match(h.calls[2].sql, /payload->>'userId'=\$3/);
  assert.deepEqual(h.calls[2].values.slice(0, 3), ['workflow-a', 'tenant-a', 'owner-a']);
});

test('owner-scoped workflow save does not overwrite a workflow owned by another principal', async () => {
  const h = fixture([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }]);
  await assert.rejects(
    h.repo.save(h.instance, 'tenant-a', { persistencePrincipal: h.principal }),
    error => error.code === 'WORKFLOW_NOT_FOUND'
  );
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].sql, /payload->>'userId'/);
  assert.match(h.calls[1].sql, /ON CONFLICT\(workflow_id\) DO NOTHING/);
});

test('owner-scoped workflow reads apply the owner predicate inside a principal transaction', async () => {
  const h = fixture([{ rows: [{ payload: hPayload() }], rowCount: 1 }]);
  const result = await h.repo.findById('workflow-a', 'tenant-a', { persistencePrincipal: h.principal });
  assert.equal(result.userId, 'owner-a');
  assert.equal(h.transactions, 1);
  assert.match(h.calls[0].sql, /payload->>'userId'/);
  assert.deepEqual(h.calls[0].values, ['workflow-a', 'tenant-a', 'owner-a']);
});

test('owner principal cannot write a workflow for a different owner or tenant', async () => {
  const h = fixture();
  await assert.rejects(
    h.repo.save({ ...h.instance, userId: 'owner-b' }, 'tenant-a', { persistencePrincipal: h.principal }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.transactions, 0);
});

function hPayload() {
  return { workflowId: 'workflow-a', tenantId: 'tenant-a', userId: 'owner-a', state: 'WAITING' };
}
