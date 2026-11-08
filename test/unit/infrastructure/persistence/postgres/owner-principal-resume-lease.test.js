'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresCheckpointRepository } = require('../../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const { createPersistencePrincipal } = require('../../../../../src/core/security/persistence-principal');

function principal(ownerId = 'owner-a') {
  return createPersistencePrincipal({ tenantId: 'tenant-a', ownerId, sessionId: 'session-' + ownerId });
}

test('checkpoint recovery and resume leases remain bound to the same owner principal', async () => {
  const snapshot = {
    executionId: 'exec-a',
    tenantId: 'tenant-a',
    userId: 'owner-a',
    status: 'running'
  };
  const calls = [];
  const repository = new PostgresCheckpointRepository({
    query() { throw new Error('Principal-scoped checkpoint operations must use transactionWithPrincipal'); },
    async transactionWithPrincipal(identity, work) {
      assert.equal(identity.tenantId, 'tenant-a');
      const client = {
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (sql.startsWith('SELECT * FROM checkpoints')) {
            const owner = values.find(value => value === 'owner-a' || value === 'owner-b');
            if (owner !== 'owner-a') return { rows: [], rowCount: 0 };
            return {
              rows: [{
                execution_id: 'exec-a',
                tenant_id: 'tenant-a',
                sequence: 1,
                checkpoint_id: 'checkpoint-a',
                reason: 'step_completed',
                created_at: new Date().toISOString(),
                snapshot,
                snapshot_sha256: repository.digest(snapshot)
              }],
              rowCount: 1
            };
          }
          if (sql.startsWith('INSERT INTO execution_resume_leases')) {
            return {
              rows: [{
                lease_id: 'lease-a',
                acquired_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 30000).toISOString()
              }],
              rowCount: 1
            };
          }
          if (sql.startsWith('UPDATE execution_resume_leases')) {
            return {
              rows: [{
                lease_id: 'lease-a',
                acquired_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 30000).toISOString()
              }],
              rowCount: 1
            };
          }
          if (sql.startsWith('DELETE FROM execution_resume_leases')) return { rows: [], rowCount: 1 };
          throw new Error('Unexpected SQL: ' + sql);
        }
      };
      return work(client, identity);
    }
  });

  const recovered = await repository.findLatest('exec-a', {
    tenantId: 'tenant-a',
    persistencePrincipal: principal('owner-a')
  });
  assert.equal(recovered.snapshot.userId, 'owner-a');

  const hidden = await repository.findLatest('exec-a', {
    tenantId: 'tenant-a',
    persistencePrincipal: principal('owner-b')
  });
  assert.equal(hidden, null);

  const lease = await repository.acquireResumeLease('exec-a', {
    tenantId: 'tenant-a',
    leaseDurationMs: 30000,
    persistencePrincipal: principal('owner-a')
  });
  assert.equal(lease.leaseId, 'lease-a');

  const renewed = await repository.renewResumeLease('exec-a', 'lease-a', {
    tenantId: 'tenant-a',
    leaseDurationMs: 30000,
    persistencePrincipal: principal('owner-a')
  });
  assert.equal(renewed.leaseId, 'lease-a');

  const released = await repository.releaseResumeLease('exec-a', 'lease-a', {
    tenantId: 'tenant-a',
    persistencePrincipal: principal('owner-a')
  });
  assert.equal(released, true);

  assert.ok(calls.some(call => call.sql.includes("snapshot->>'userId'")));
  assert.ok(calls.some(call => call.sql.includes('EXISTS (SELECT 1 FROM checkpoints')));
});
