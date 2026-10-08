const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WorkflowRepository = require('../../../src/infrastructure/persistence/json/workflow.repository');

test('serializes concurrent workflow saves without losing records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflows-'));
  const file = path.join(dir, 'workflows.json');
  const worker = path.join(dir, 'worker.js');

  fs.writeFileSync(worker, `
    const WorkflowRepository = require(${JSON.stringify(path.resolve(__dirname, '../../../src/infrastructure/persistence/json/workflow.repository'))});
    const repo = new WorkflowRepository(process.argv[2]);
    const id = process.argv[3];
    repo.save({ workflowId: id, tenantId: 'tenant-a', state: 'RUNNING' }, 'tenant-a');
  `);

  await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, file, `workflow-${index}`], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`)));
  })));

  const repo = new WorkflowRepository(file);
  assert.equal(repo.findAll({ tenantId: 'tenant-a' }).length, 6);
});
