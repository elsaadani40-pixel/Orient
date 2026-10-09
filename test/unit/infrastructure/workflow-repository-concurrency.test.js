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


test('workflow repository does not reclaim an old lock owned by a live process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflow-live-lock-'));
  const file = path.join(dir, 'workflows.json');
  const repo = new WorkflowRepository(file, { lockTimeoutMs: 20 });
  try {
    fs.mkdirSync(repo.lockPath);
    fs.writeFileSync(path.join(repo.lockPath, 'owner.json'), JSON.stringify({
      token: 'live-owner', pid: process.pid, hostname: os.hostname(), acquiredAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(repo.lockPath, old, old);
    assert.throws(() => repo.withLock(() => 'must not run'),
      error => error.code === 'WORKFLOW_STORAGE_LOCK_TIMEOUT');
    assert.equal(fs.existsSync(repo.lockPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow repository recovers a lock whose local owner process is dead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflow-dead-lock-'));
  const file = path.join(dir, 'workflows.json');
  const repo = new WorkflowRepository(file, { lockTimeoutMs: 100 });
  try {
    fs.mkdirSync(repo.lockPath);
    fs.writeFileSync(path.join(repo.lockPath, 'owner.json'), JSON.stringify({
      token: 'dead-owner', pid: 2147483647, hostname: os.hostname(), acquiredAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(repo.lockPath, old, old);
    assert.equal(repo.withLock(() => 'acquired'), 'acquired');
    assert.equal(fs.existsSync(repo.lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
