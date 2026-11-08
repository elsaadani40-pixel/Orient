'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresApprovalRepository } = require('../../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const { createPersistencePrincipal } = require('../../../../../src/core/security/persistence-principal');

const ownerPrincipal = createPersistencePrincipal({
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  sessionId: 'session-a'
});

function row(overrides = {}) {
  return {
    approval_id: 'approval-a',
    tenant_id: 'tenant-a',
    execution_id: 'execution-a',
    step: 1,
    plan_revision: 1,
    tool: 'safe-tool',
    capability: 'safe:read',
    scope: {},
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    used: false,
    used_at: null,
    metadata: { tenantId: 'tenant-a' },
    ...overrides
  };
}

function createHarness() {
  const calls = [];
  let current = row();
  let transactionCount = 0;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT a.* FROM approvals')) {
        const owner = values.find(value => value === 'owner-a' || value === 'owner-b');
        if (owner === 'owner-b') return { rows: [], rowCount: 0 };
        if (sql.includes('a.execution_id=$1') && values[0] !== 'execution-a') return { rows: [], rowCount: 0 };
        return { rows: [current], rowCount: 1 };
      }
      if (sql.startsWith('SELECT a.* FROM approvals')) return { rows: [current], rowCount: 1 };
      if (sql.startsWith('UPDATE approvals SET metadata')) {
        const decision = JSON.parse(values[0]);
        current = { ...current, metadata: { ...current.metadata, decision } };
        return { rows: [current], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE approvals SET used=TRUE')) {
        const owner = values.find(value => value === 'owner-a' || value === 'owner-b');
        if (owner === 'owner-b' || current.used) return { rows: [], rowCount: 0 };
        current = { ...current, used: true, used_at: values[0] };
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const db = {
    query() { throw new Error('Owner-scoped approval access escaped its transaction'); },
    async transactionWithPrincipal(principal, work) {
      transactionCount += 1;
      return work(client, principal);
    }
  };
  return { db, calls, get current() { return current; }, get transactionCount() { return transactionCount; } };
}

test('approval lookup and inbox queries are scoped to the execution owner', async () => {
  const harness = createHarness();
  const repository = new PostgresApprovalRepository(harness.db);
  const found = await repository.findById('approval-a', { tenantId: 'tenant-a', persistencePrincipal: ownerPrincipal });
  assert.equal(found.approvalId, 'approval-a');
  const hidden = await repository.findById('approval-a', {
    tenantId: 'tenant-a',
    persistencePrincipal: createPersistencePrincipal({ tenantId: 'tenant-a', ownerId: 'owner-b', sessionId: 'session-b' })
  });
  assert.equal(hidden, null);
  const byExecution = await repository.findByExecution({
    executionId: 'execution-a', tenantId: 'tenant-a', persistencePrincipal: ownerPrincipal
  });
  assert.equal(byExecution.length, 1);
  const pending = await repository.findPending({
    tenantId: 'tenant-a', persistencePrincipal: ownerPrincipal, now: Date.now()
  });
  assert.equal(pending.length, 1);
  assert.ok(harness.calls.every(call => call.sql.includes("e.payload->>'userId'")));
  assert.equal(harness.transactionCount, 3);
});

test('approval decisions and consumption are owner-scoped and atomic', async () => {
  const harness = createHarness();
  const repository = new PostgresApprovalRepository(harness.db);
  const decision = {
    status: 'approved',
    actorId: 'session-a',
    decidedAt: new Date().toISOString()
  };
  const decided = await repository.recordDecision('approval-a', decision, 'tenant-a', Date.now, ownerPrincipal);
  assert.equal(decided.decision.status, 'approved');

  const consumed = await repository.consume('approval-a', new Date().toISOString(), 'tenant-a', {
    persistencePrincipal: ownerPrincipal
  });
  assert.equal(consumed, true);
  assert.equal(harness.current.used, true);
  assert.ok(harness.calls.every(call => call.sql.includes("e.payload->>'userId'") || call.sql.startsWith('UPDATE approvals SET used=TRUE')));
  assert.equal(harness.transactionCount, 2);
});
