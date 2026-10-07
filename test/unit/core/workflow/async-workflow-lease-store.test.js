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
