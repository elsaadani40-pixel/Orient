const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CheckpointRepository = require('../../../src/infrastructure/persistence/json/checkpoint.repository');

test('durable JSON checkpoints serialize concurrent saves and preserve sequence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-checkpoint-'));
  const filePath = path.join(directory, 'checkpoints.json');
  const modulePath = path.resolve(__dirname, '../../../src/infrastructure/persistence/json/checkpoint.repository.js');
  const worker = `
    const fs = require('fs');
    const Repository = require(process.argv[1]);
    const file = process.argv[2];
    const ready = process.argv[3];
    const start = process.argv[4];
    const index = Number(process.argv[5]);
    const repository = new Repository(file);
    fs.writeFileSync(ready, 'ready');
    while (!fs.existsSync(start)) {}
    repository.save({
      executionId: 'shared-execution',
      tenantId: 'local',
      input: 'concurrent-' + index,
      status: 'running'
    }, { tenantId: 'local', reason: 'concurrency-test' });
    process.stdout.write('saved');
  `;

  const workers = [];
  try {
    for (let index = 0; index < 6; index += 1) {
      const ready = path.join(directory, 'ready-' + index);
      workers.push({
        ready,
        child: spawn(process.execPath, ['-e', worker, modulePath, filePath, ready, path.join(directory, 'start'), String(index)], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
      });
    }
    for (const item of workers) {
      while (!fs.existsSync(item.ready)) await new Promise(resolve => setTimeout(resolve, 5));
    }
    fs.writeFileSync(path.join(directory, 'start'), 'go');

    const outputs = await Promise.all(workers.map(item => new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      item.child.stdout.on('data', chunk => { stdout += chunk; });
      item.child.stderr.on('data', chunk => { stderr += chunk; });
      item.child.on('error', reject);
      item.child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    })));

    assert.equal(outputs.filter(value => value === 'saved').length, 6);
    const repository = new CheckpointRepository(filePath);
    const latest = repository.findLatest('shared-execution', { tenantId: 'local' });
    assert.equal(latest.sequence, 6);
    assert.doesNotThrow(() => repository.findLatest('shared-execution', { verify: true, tenantId: 'local' }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
