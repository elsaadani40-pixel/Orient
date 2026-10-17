'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MemoryAuditRepository = require('../../src/infrastructure/memory/memory-audit.repository');

function runWriter(repositoryModule, filePath, workerId, count) {
  return new Promise((resolve, reject) => {
    const source = `
      const Repository = require(${JSON.stringify(repositoryModule)});
      const repository = new Repository(${JSON.stringify(filePath)});
      for (let i = 0; i < ${count}; i += 1) {
        repository.append({ action: 'test.concurrent', workerId: ${JSON.stringify(workerId)}, sequence: i });
      }
    `;
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`writer ${workerId} exited ${code}: ${stderr}`));
    });
  });
}

test('concurrent processes append every audit event without losing updates', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-audit-'));
  const filePath = path.join(directory, 'audit.json');
  const repositoryModule = path.resolve(__dirname, '../../src/infrastructure/memory/memory-audit.repository.js');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const workerCount = 4;
  const writesPerWorker = 12;
  await Promise.all(
    Array.from({ length: workerCount }, (_, index) =>
      runWriter(repositoryModule, filePath, `worker-${index}`, writesPerWorker)
    )
  );

  const events = new MemoryAuditRepository(filePath).read();
  assert.equal(events.length, workerCount * writesPerWorker);
  assert.equal(new Set(events.map(event => `${event.workerId}:${event.sequence}`)).size, events.length);
});

test('same-process concurrent append requests retain every unique event', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-audit-local-'));
  const filePath = path.join(directory, 'audit.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new MemoryAuditRepository(filePath);
  const count = 64;

  await Promise.all(Array.from({ length: count }, (_, sequence) =>
    Promise.resolve().then(() => repository.append({
      action: 'test.same-process',
      workerId: 'single-process',
      sequence
    }))
  ));

  const events = repository.read();
  assert.equal(events.length, count);
  assert.equal(new Set(events.map(event => event.sequence)).size, count);
});
