'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresWorkflowRepository } = require('../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const { createWorkerPersistencePrincipal } = require('../../../../src/core/security/worker-persistence-principal');

function fixture({ workerRows = 1, workflowRows = 1, leaseRows = 1, updateRows = 1 } = {}) {
  const calls = [];
  let transactions = 0;
  let workerChecks = 0;
  let requireLease = false;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM worker_nodes')) {
        const configuredRows = Array.isArray(workerRows) ? workerRows[Math.min(workerChecks, workerRows.length - 1)] : workerRows;
        workerChecks += 1;
        return { rowCount: configuredRows, rows: configuredRows ? [{}] : [] };
      }
      if (sql.includes('FROM workflows')) return { rowCount: workflowRows, rows: workflowRows ? [{}] : [] };
      if (sql.includes('FROM workflow_leases')) return { rowCount: leaseRows, rows: leaseRows ? [{}] : [] };
      if (sql.includes('UPDATE workflows')) return { rowCount: updateRows, rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const db = {
    async query() { throw new Error('Fenced workflow writes must not use the pool query path'); },
    async transactionWithWorkerPrincipal(principal, work, options) {
      transactions += 1;
      requireLease = options?.requireLease === true;
      assert.equal(principal.kind, 'worker');
      return work(client, principal);
    }
  };
  const principal = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'session-a',
    capabilities: ['web.search'], workflowId: 'workflow-a', leaseId: 'lease-a', fencingToken: 71
  });
  const instance = {
    workflowId: 'workflow-a', tenantId: 'tenant-a', state: 'RUNNING',
    updatedAt: new Date().toISOString(), metadata: { fencingToken: 71 },
    toJSON() { return { workflowId: this.workflowId, tenantId: this.tenantId, state: this.state, updatedAt: this.updatedAt, metadata: this.metadata }; }
  };
  return { repo: new PostgresWorkflowRepository(db), db, calls, principal, instance, get transactions() { return transactions; }, get requireLease() { return requireLease; } };
}

test('fenced workflow writes require a lease-bound worker transaction and match exact session and lease', async () => {
  const h = fixture();
  const saved = await h.repo.save(h.instance, 'tenant-a', { workerPrincipal: h.principal });
  assert.equal(saved.workflowId, 'workflow-a');
  assert.equal(h.transactions, 1);
  assert.equal(h.requireLease, true);
  assert.match(h.calls[0].sql, /session_id=\$3/);
  assert.match(h.calls[0].sql, /status='READY'/);
  assert.match(h.calls[0].sql, /clock_timestamp\(\)/);
  assert.match(h.calls[1].sql, /FROM workflows/);
  assert.match(h.calls[1].sql, /FOR UPDATE/);
  assert.match(h.calls[2].sql, /FROM worker_nodes/);
  assert.match(h.calls[2].sql, /clock_timestamp\(\)/);
  assert.match(h.calls[3].sql, /worker_session_id=\$5/);
  assert.match(h.calls[3].sql, /lease_id=\$3/);
  assert.match(h.calls[3].sql, /fencing_token=\$6/);
  assert.match(h.calls[3].sql, /clock_timestamp\(\)/);
  assert.match(h.calls[3].sql, /FOR UPDATE/);
  assert.deepEqual(h.calls[3].values, ['workflow-a', 'tenant-a', 'lease-a', 'worker-a', 'session-a', 71]);
  assert.match(h.calls[4].sql, /UPDATE workflows/);
});

test('fenced workflow writes reject expired or replaced worker sessions', async () => {
  const h = fixture({ workerRows: 0 });
  await assert.rejects(
    h.repo.save(h.instance, 'tenant-a', { workerPrincipal: h.principal }),
    error => error.code === 'WORKER_SESSION_LOST'
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.transactions, 1);
});

test('fenced workflow writes revalidate worker expiry after waiting for the workflow lock', async () => {
  const h = fixture({ workerRows: [1, 0] });
  await assert.rejects(
    h.repo.save(h.instance, 'tenant-a', { workerPrincipal: h.principal }),
    error => error.code === 'WORKER_SESSION_LOST'
  );
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[2].sql, /clock_timestamp\\(\\)/);
});

test('fenced workflow writes reject stale lease rows even for a live worker session', async () => {
  const h = fixture({ leaseRows: 0 });
  await assert.rejects(
    h.repo.save(h.instance, 'tenant-a', { workerPrincipal: h.principal }),
    error => error.code === 'WORKFLOW_FENCING_REJECTED'
  );
  assert.equal(h.calls.length, 4);
});

test('fenced workflow writes reject missing or mismatched principals before database access', async () => {
  const h = fixture();
  await assert.rejects(
    h.repo.save(h.instance, 'tenant-a'),
    error => error.code === 'WORKER_PERSISTENCE_PRINCIPAL_REQUIRED'
  );
  const wrongLease = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'session-a',
    workflowId: 'other-workflow', leaseId: 'other-lease', fencingToken: 71
  });
  await assert.rejects(
    h.repo.save(h.instance, 'tenant-a', { workerPrincipal: wrongLease }),
    error => error.code === 'WORKFLOW_FENCING_REJECTED'
  );
  assert.equal(h.transactions, 0);
});


test('unleased workflow writes cannot overwrite a workflow with an active durable lease', async () => {
  const calls = [];
  const db = {
    async transaction(work) {
      return work({
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (sql.includes('SELECT workflow_id FROM workflows')) return { rowCount: 1, rows: [{ workflow_id: 'workflow-active-lease' }] };
          if (sql.includes('FROM workflow_dispatch_claims')) return { rowCount: 0, rows: [] };
          if (sql.includes('FROM workflow_leases')) return { rowCount: 1, rows: [{}] };
          throw new Error('Unexpected SQL: ' + sql);
        }
      });
    }
  };
  const repo = new PostgresWorkflowRepository(db);
  await assert.rejects(
    repo.save({
      workflowId: 'workflow-active-lease', tenantId: 'tenant-a', state: 'QUEUED',
      metadata: {}, updatedAt: new Date().toISOString()
    }, 'tenant-a'),
    error => error.code === 'WORKFLOW_LEASE_HELD'
  );
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[1].sql, /workflow_dispatch_claims/);
  assert.match(calls[2].sql, /workflow_leases/);
  assert.equal(calls.length, 3);
});


test('unleased workflow writes cannot overwrite a workflow with an active durable dispatch claim', async () => {
  const calls = [];
  const db = {
    async transaction(work) {
      return work({
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (sql.includes('SELECT workflow_id FROM workflows')) return { rowCount: 1, rows: [{ workflow_id: 'workflow-active-claim' }] };
          if (sql.includes('FROM workflow_dispatch_claims')) return { rowCount: 1, rows: [{}] };
          throw new Error('Unexpected SQL: ' + sql);
        }
      });
    }
  };
  const repo = new PostgresWorkflowRepository(db);
  await assert.rejects(
    repo.save({
      workflowId: 'workflow-active-claim', tenantId: 'tenant-a', state: 'QUEUED',
      metadata: {}, updatedAt: new Date().toISOString()
    }, 'tenant-a'),
    error => error.code === 'WORKFLOW_DISPATCH_CLAIM_HELD'
  );
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[1].sql, /workflow_dispatch_claims/);
  assert.equal(calls.length, 2, 'the workflow must not be updated while a dispatch claim is active');
});
