const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WorkflowLeaseRepository = require('../../../src/infrastructure/persistence/json/workflow-lease.repository');

test('durable workflow lease acquisition is atomic across processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflow-leases-'));
  const file = path.join(dir, 'leases.json');
  const worker = path.join(dir, 'worker.js');

  fs.writeFileSync(worker, `
    const WorkflowLeaseRepository = require(${JSON.stringify(path.resolve(__dirname, '../../../src/infrastructure/persistence/json/workflow-lease.repository'))});
    const repo = new WorkflowLeaseRepository(process.argv[2]);
    const lease = {
      workflowId: 'workflow-1',
      leaseId: process.argv[3],
      workerId: process.argv[3],
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30000,
      metadata: { tenantId: 'tenant-a' }
    };
    const acquired = repo.tryAcquire(lease, 'tenant-a');
    process.exit(acquired ? 0 : 2);
  `);

  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, file, `worker-${index}`], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  })));

  assert.equal(results.filter(code => code === 0).length, 1);
  assert.equal(results.filter(code => code === 2).length, 5);

  const repo = new WorkflowLeaseRepository(file);
  const lease = repo.findByWorkflowId('workflow-1', 'tenant-a');
  assert.ok(lease);
  assert.equal(lease.fencingToken, 1);
});
