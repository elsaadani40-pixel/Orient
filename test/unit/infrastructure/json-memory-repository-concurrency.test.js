const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const JsonMemoryRepository = require('../../../src/infrastructure/memory/json-memory.repository');

test('serializes concurrent memory inserts without losing tenant records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-'));
  const file = path.join(dir, 'memories.json');
  const worker = path.join(dir, 'worker.js');

  fs.writeFileSync(worker, `
    const JsonMemoryRepository = require(${JSON.stringify(path.resolve(__dirname, '../../../src/infrastructure/memory/json-memory.repository'))});
    const repo = new JsonMemoryRepository(process.argv[2]);
    repo.insert({
      id: process.argv[3],
      tenantId: 'tenant-a',
      scope: 'personal',
      text: process.argv[3],
      type: 'note'
    });
  `);

  await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, file, `memory-${index}`], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`)));
  })));

  const memories = new JsonMemoryRepository(file).findAll('tenant-a', 'personal');
  assert.equal(memories.length, 6);
  assert.deepEqual(new Set(memories.map(memory => memory.id)),
    new Set(Array.from({ length: 6 }, (_, index) => `memory-${index}`)));
});

test('prevents memory tenant and scoped identity escalation on update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-integrity-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file);
  repo.insert({ id: 'memory-1', tenantId: 'tenant-a', scope: 'personal', text: 'secret', type: 'note' });

  assert.throws(() => repo.update('memory-1', { tenantId: 'tenant-b' }, 'tenant-a', 'personal'),
    error => error.code === 'MEMORY_TENANT_IMMUTABLE');
  assert.throws(() => repo.update('memory-1', { scope: 'private' }, 'tenant-a', 'personal'),
    error => error.code === 'MEMORY_SCOPE_IMMUTABLE');

  const stored = repo.findById('memory-1', 'tenant-a', 'personal');
  assert.equal(stored.tenantId, 'tenant-a');
  assert.equal(stored.scope, 'personal');
});
