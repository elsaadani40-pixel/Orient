const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ExecutionRepository = require('../../../src/infrastructure/persistence/json/execution.repository');

test('serializes concurrent inserts without losing executions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-executions-'));
  const file = path.join(dir, 'executions.json');
  const worker = path.join(dir, 'worker.js');

  fs.writeFileSync(worker, `
    const ExecutionRepository = require(${JSON.stringify(path.resolve(__dirname, '../../../src/infrastructure/persistence/json/execution.repository'))});
    const repo = new ExecutionRepository(process.argv[2]);
    const id = process.argv[3];
    repo.insert({
      id,
      executionId: id,
      status: 'created',
      metadata: { tenantId: 'tenant-a' }
    }, { tenantId: 'tenant-a' });
  `);

  await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const id = `execution-${index}`;
    const child = spawn(process.execPath, [worker, file, id], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`worker exited with ${code}`)));
  })));

  const repo = new ExecutionRepository(file);
  const executions = repo.findAll({ tenantId: 'tenant-a' });

  assert.equal(executions.length, 6);
  assert.deepEqual(
    new Set(executions.map(execution => execution.executionId)),
    new Set(Array.from({ length: 6 }, (_, index) => `execution-${index}`))
  );
});

test('serializes concurrent updates and preserves the final durable state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-executions-update-'));
  const file = path.join(dir, 'executions.json');
  const worker = path.join(dir, 'worker.js');
  const repo = new ExecutionRepository(file);

  repo.insert({
    id: 'execution-1',
    executionId: 'execution-1',
    status: 'created',
    metadata: { tenantId: 'tenant-a' },
    result: null
  }, { tenantId: 'tenant-a' });

  fs.writeFileSync(worker, `
    const ExecutionRepository = require(${JSON.stringify(path.resolve(__dirname, '../../../src/infrastructure/persistence/json/execution.repository'))});
    const repo = new ExecutionRepository(process.argv[2]);
    const value = process.argv[3];
    repo.update('execution-1', {
      result: { worker: value },
      metadata: { tenantId: 'tenant-a' }
    }, { tenantId: 'tenant-a' });
  `);

  await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, file, String(index)], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`worker exited with ${code}`)));
  })));

  const persisted = new ExecutionRepository(file).findById('execution-1', { tenantId: 'tenant-a' });
  assert.equal(persisted.executionId, 'execution-1');
  assert.ok(persisted.result && /^[0-5]$/.test(String(persisted.result.worker)));
  assert.equal(persisted.metadata.tenantId, 'tenant-a');
  assert.equal(fs.existsSync(`${file}.lock`), false);
});
