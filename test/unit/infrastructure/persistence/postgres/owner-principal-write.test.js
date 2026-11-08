'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PostgresExecutionRepository,
  PostgresEventRepository,
  PostgresCheckpointRepository
} = require('../../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const { createPersistencePrincipal } = require('../../../../../src/core/security/persistence-principal');

function makePrincipal(ownerId = 'owner-a') {
  return createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId,
    sessionId: 'session-' + ownerId
  });
}

function createHarness(seed = []) {
  const calls = [];
  const executions = new Map(seed.map(record => [record.executionId, { ...record }]));
  const checkpoints = [];
  const events = [];
  let transactions = 0;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith('INSERT INTO executions')) {
        const [executionId, tenantId, payload] = values;
        executions.set(executionId, payload);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM executions') && sql.includes('payload') && sql.startsWith('SELECT')) {
        const [executionId, tenantId, ownerId] = values;
        const record = executions.get(executionId);
        if (!record || (tenantId && record.tenantId !== tenantId) ||
            (ownerId && record.userId !== ownerId)) return { rows: [], rowCount: 0 };
        return { rows: [{ payload: record }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE executions')) {
        const [executionId, tenantId, payload] = values;
        const record = executions.get(executionId);
        if (!record || record.tenantId !== tenantId) return { rows: [], rowCount: 0 };
        const ownerId = values[5] || values[4];
        if (ownerId && record.userId !== ownerId) return { rows: [], rowCount: 0 };
        const updated = sql.includes('jsonb_set') ? {
          ...record,
          cancellationRequested: true,
          cancellationReason: values[2]
        } : payload;
        executions.set(executionId, updated);
        return { rows: [{ payload: updated }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT 1 FROM executions')) {
        const [executionId, tenantId, ownerId] = values;
        const record = executions.get(executionId);
        return { rows: record && record.tenantId === tenantId && record.userId === ownerId ? [{ '?column?': 1 }] : [], rowCount: record && record.tenantId === tenantId && record.userId === ownerId ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO events')) {
        events.push(values[6]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT tenant_id FROM checkpoints')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT COALESCE(MAX(sequence)')) return { rows: [{ next_sequence: 1 }], rowCount: 1 };
      if (sql.startsWith('INSERT INTO checkpoints')) {
        const row = {
          execution_id: values[0], tenant_id: values[1], sequence: values[2],
          checkpoint_id: values[3], reason: values[4], created_at: values[5],
          snapshot: values[6], snapshot_sha256: values[7]
        };
        checkpoints.push(row);
        return { rows: [row], rowCount: 1 };
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const db = {
    query() { throw new Error('Principal operation escaped its checked-out transaction client'); },
    async transactionWithPrincipal(principal, work) {
      transactions += 1;
      assert.equal(principal.tenantId, 'tenant-a');
      const checkpointCount = checkpoints.length;
      const eventCount = events.length;
      const executionSnapshot = new Map(executions);
      try {
        return await work(client, principal);
      } catch (error) {
        checkpoints.length = checkpointCount;
        events.length = eventCount;
        executions.clear();
        for (const [key, value] of executionSnapshot) executions.set(key, value);
        throw error;
      }
    },
    async transaction(work) {
      transactions += 1;
      return work(client);
    }
  };
  return { db, calls, executions, checkpoints, events, get transactions() { return transactions; } };
}

test('execution insert uses owner principal transaction and rejects owner mismatch before SQL', async () => {
  const harness = createHarness();
  const repository = new PostgresExecutionRepository(harness.db);
  const principal = makePrincipal();
  await repository.insert({
    executionId: 'exec-a',
    tenantId: 'tenant-a',
    userId: 'owner-a',
    status: 'running'
  }, { tenantId: 'tenant-a', persistencePrincipal: principal });
  assert.equal(harness.transactions, 1);
  assert.equal(harness.executions.get('exec-a').userId, 'owner-a');

  const before = harness.calls.length;
  await assert.rejects(
    repository.insert({
      executionId: 'exec-b',
      tenantId: 'tenant-a',
      userId: 'owner-b',
      status: 'running'
    }, { tenantId: 'tenant-a', persistencePrincipal: principal }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.equal(harness.calls.length, before, 'owner mismatch must be rejected before SQL');
});

test('execution update and cancellation remain owner-scoped inside one transaction', async () => {
  const harness = createHarness([{
    executionId: 'exec-a',
    tenantId: 'tenant-a',
    userId: 'owner-a',
    status: 'running',
    cancellationRequested: false
  }]);
  const repository = new PostgresExecutionRepository(harness.db);
  const principal = makePrincipal();

  const updated = await repository.update('exec-a', {
    executionId: 'exec-a',
    tenantId: 'tenant-a',
    userId: 'owner-a',
    status: 'completed'
  }, { tenantId: 'tenant-a', persistencePrincipal: principal });
  assert.equal(updated.status, 'completed');

  const cancelled = await repository.requestCancellation('exec-a', 'owner-requested', {
    tenantId: 'tenant-a',
    persistencePrincipal: principal
  });
  assert.equal(cancelled.cancellationRequested, true);
  assert.equal(harness.transactions, 2);
  assert.ok(harness.calls.some(call => call.sql.includes("payload->>'userId'=$3")));
});

test('event appendMany verifies execution ownership before writing events', async () => {
  const harness = createHarness([{
    executionId: 'exec-a',
    tenantId: 'tenant-a',
    userId: 'owner-a',
    status: 'running'
  }]);
  const repository = new PostgresEventRepository(harness.db);
  const inserted = await repository.appendMany([{
    id: 'event-a',
    type: 'execution.started',
    executionId: 'exec-a',
    data: { tenantId: 'tenant-a' }
  }], { tenantId: 'tenant-a', persistencePrincipal: makePrincipal() });

  assert.equal(inserted.length, 1);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.transactions, 1);

  await assert.rejects(
    repository.appendMany([{
      id: 'event-b',
      type: 'execution.started',
      executionId: 'exec-a',
      data: { tenantId: 'tenant-a' }
    }], { tenantId: 'tenant-a', persistencePrincipal: makePrincipal('owner-b') }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.equal(harness.events.length, 1);
});

test('checkpoint creation requires the same owner as its durable execution', async () => {
  const harness = createHarness([{
    executionId: 'exec-a',
    tenantId: 'tenant-a',
    userId: 'owner-a',
    status: 'running'
  }]);
  const repository = new PostgresCheckpointRepository(harness.db);
  const checkpoint = await repository.save({
    executionId: 'exec-a',
    tenantId: 'tenant-a',
    userId: 'owner-a',
    status: 'running',
    events: []
  }, {
    tenantId: 'tenant-a',
    reason: 'test',
    persistencePrincipal: makePrincipal()
  });

  assert.equal(checkpoint.executionId, 'exec-a');
  assert.equal(harness.checkpoints.length, 1);
  assert.equal(harness.transactions, 1);

  const before = harness.calls.length;
  await assert.rejects(
    repository.save({
      executionId: 'exec-a',
      tenantId: 'tenant-a',
      userId: 'owner-b',
      status: 'running',
      events: []
    }, { tenantId: 'tenant-a', persistencePrincipal: makePrincipal('owner-b') }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.ok(harness.calls.length > before, 'ownership is verified inside the principal transaction');
  assert.equal(harness.checkpoints.length, 1, 'the rejected transaction must roll back its checkpoint insert');
});
