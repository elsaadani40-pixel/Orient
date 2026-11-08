const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowLeaseStore = require('../../../../src/core/workflow/async-workflow-lease-store');

test('AsyncWorkflowLeaseStore preserves durable fencing token returned by repository', async () => {
  const store = new AsyncWorkflowLeaseStore({
    tenantId: 'tenant-a',
    repository: {
      async tryAcquire(lease) { return { ...lease, fencingToken: 17 }; }
    },
    clock: () => 1000,
    leaseDurationMs: 30000
  });
  const lease = await store.acquire('wf-1', 'worker-1', { tenantId: 'tenant-a' });
  assert.equal(lease.fencingToken, 17);
  assert.equal(lease.metadata.fencingToken, 17);
  assert.equal((await store.get('wf-1')).fencingToken, 17);
});


test('AsyncWorkflowLeaseStore forwards the exact worker principal to every lease lifecycle operation', async () => {
  const { createWorkerPersistencePrincipal } = require('../../../../src/core/security/worker-persistence-principal');
  const calls = [];
  const repository = {
    async tryAcquire(lease, tenantId, options) {
      calls.push(['acquire', options.workerPrincipal]);
      return { ...lease, fencingToken: 19 };
    },
    async renewIfOwned(workflowId, leaseId, expiresAt, now, tenantId, options) {
      calls.push(['renew', options.workerPrincipal]);
      return true;
    },
    async assertCurrent(workflowId, leaseId, fencingToken, now, tenantId, options) {
      calls.push(['assert', options.workerPrincipal]);
      return true;
    },
    async delete(workflowId, leaseId, tenantId, options) {
      calls.push(['release', options.workerPrincipal]);
      return true;
    }
  };
  const store = new AsyncWorkflowLeaseStore({
    tenantId: 'tenant-a',
    repository,
    clock: () => 1000,
    leaseDurationMs: 30000
  });
  const worker = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'session-a', capabilities: []
  });
  const lease = await store.acquire('wf-1', 'worker-a', { tenantId: 'tenant-a' }, worker);
  const bound = createWorkerPersistencePrincipal({
    tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'session-a', capabilities: [],
    workflowId: 'wf-1', leaseId: lease.leaseId, fencingToken: lease.fencingToken
  });
  await store.renew('wf-1', lease.leaseId, bound);
  await store.assertCurrent('wf-1', lease.leaseId, lease.fencingToken, bound);
  await store.release('wf-1', lease.leaseId, bound);
  assert.deepEqual(calls.map(call => call[0]), ['acquire', 'renew', 'assert', 'release']);
  assert.equal(calls[0][1], worker);
  assert.ok(calls.slice(1).every(call => call[1] === bound));
});
