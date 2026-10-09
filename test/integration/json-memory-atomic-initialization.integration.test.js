'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repositoryModule = path.resolve(__dirname, '../../src/infrastructure/memory/json-memory.repository.js');
const workerCount = 8;

function runConcurrentWriter({ storePath, text, tenantId }) {
  const script = [
    "'use strict';",
    'const JsonMemoryRepository = require(' + JSON.stringify(repositoryModule) + ');',
    'const repository = new JsonMemoryRepository(' + JSON.stringify(storePath) + ');',
    'repository.insert({ text: ' + JSON.stringify(text) + ', tenantId: ' + JSON.stringify(tenantId) + ', type: "fact", scope: "stress" });'
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error('Memory writer exited ' + code + ': ' + stderr));
    });
  });
}

function assertAllWritesPersisted(storePath, expectedTexts) {
  const JsonMemoryRepository = require(repositoryModule);
  const repository = new JsonMemoryRepository(storePath);
  const records = repository.readRaw();
  assert.equal(records.length, expectedTexts.length, 'every successful insert must remain persisted');
  assert.deepEqual(
    new Set(records.map(record => record.text)),
    new Set(expectedTexts),
    'no concurrent writer record may be lost or replaced'
  );
  for (const record of records) {
    assert.equal(record.scope, 'stress');
    assert.ok(record.tenantId);
  }
}

test('concurrent first-time JSON memory initialization never truncates successful inserts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-init-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Repeatedly start independent Node processes against a store that does not exist yet.
  for (let round = 0; round < 6; round += 1) {
    const storePath = path.join(root, 'round-' + round, 'memory.json');
    const expectedTexts = Array.from({ length: workerCount }, (_, index) => 'first-init-' + round + '-' + index);
    await Promise.all(expectedTexts.map((text, index) => runConcurrentWriter({
      storePath,
      text,
      tenantId: 'tenant-' + index
    })));
    assertAllWritesPersisted(storePath, expectedTexts);
  }
});

test('concurrent constructors cannot migrate a stale JSON snapshot over successful inserts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-migration-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const storePath = path.join(root, 'memory.json');
  const legacyRecord = {
    text: 'legacy fact retained through migration',
    tenantId: 'legacy-tenant',
    type: 'fact',
    scope: 'stress'
  };
  fs.writeFileSync(storePath, JSON.stringify([legacyRecord]), { encoding: 'utf8', flag: 'wx' });

  const expectedTexts = Array.from({ length: workerCount }, (_, index) => 'migration-writer-' + index);
  await Promise.all(expectedTexts.map((text, index) => runConcurrentWriter({
    storePath,
    text,
    tenantId: 'tenant-' + index
  })));

  const JsonMemoryRepository = require(repositoryModule);
  const repository = new JsonMemoryRepository(storePath);
  const records = repository.readRaw();
  assert.equal(records.length, workerCount + 1, 'migration must preserve legacy data and every concurrent insert');
  assert.equal(records.filter(record => record.text === legacyRecord.text).length, 1);
  assert.deepEqual(
    new Set(records.filter(record => record.text !== legacyRecord.text).map(record => record.text)),
    new Set(expectedTexts)
  );
});
