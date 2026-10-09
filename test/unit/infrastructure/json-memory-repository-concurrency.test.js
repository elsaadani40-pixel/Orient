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


test('memory repository does not reclaim an old lock owned by a live process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-live-lock-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file, { lockTimeoutMs: 20 });
  try {
    fs.mkdirSync(repo.lockPath);
    fs.writeFileSync(path.join(repo.lockPath, 'owner.json'), JSON.stringify({
      token: 'live-owner', pid: process.pid, hostname: os.hostname(), acquiredAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(repo.lockPath, old, old);
    assert.throws(() => repo.withLock(() => 'must not run'),
      error => error.code === 'MEMORY_STORAGE_LOCK_TIMEOUT');
    assert.equal(fs.existsSync(repo.lockPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory repository fails closed on a stale lock directory without moving it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-dead-lock-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file, { lockTimeoutMs: 100 });
  try {
    fs.mkdirSync(repo.lockPath);
    fs.writeFileSync(path.join(repo.lockPath, 'owner.json'), JSON.stringify({
      token: 'dead-owner', pid: 2147483647, hostname: os.hostname(), acquiredAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(repo.lockPath, old, old);
    assert.throws(() => repo.withLock(() => 'must not run'), error => {
      assert.equal(error.code, 'MEMORY_STORAGE_STALE_LOCK');
      assert.equal(error.details.token, 'dead-owner');
      return true;
    });
    assert.equal(fs.existsSync(repo.lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo.lockPath, 'owner.json'), 'utf8')).token, 'dead-owner');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('memory lock publishes ownership metadata atomically and preserves operation errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-lock-publish-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file);
  const expected = new Error('protected operation failed');

  try {
    assert.throws(() => repo.withLock(() => {
      const owner = JSON.parse(fs.readFileSync(repo.lockPath, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.equal(typeof owner.token, 'string');
      assert.ok(owner.token.length > 0);
      throw expected;
    }), error => error === expected);

    assert.equal(fs.existsSync(repo.lockPath), false);
    assert.deepEqual(
      fs.readdirSync(dir).filter(name => name.startsWith('memories.json.lock.candidate.')),
      []
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('memory lock release failures are surfaced after a successful protected operation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-lock-release-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file);
  const originalRename = fs.renameSync;
  let operationRan = false;

  try {
    fs.renameSync = function(source, destination) {
      if (source === repo.lockPath) {
        const error = new Error('injected lock release failure');
        error.code = 'EACCES';
        throw error;
      }
      return originalRename.call(fs, source, destination);
    };

    assert.throws(() => repo.withLock(() => {
      operationRan = true;
      return 'completed';
    }), error => error.code === 'MEMORY_STORAGE_LOCK_RELEASE_FAILED');

    assert.equal(operationRan, true);
    assert.equal(fs.existsSync(repo.lockPath), true, 'failed release must remain observable');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory repository conservatively times out on an ownerless legacy lock directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-ownerless-lock-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file, { lockTimeoutMs: 20 });
  try {
    fs.mkdirSync(repo.lockPath);
    assert.throws(() => repo.withLock(() => 'must not run'),
      error => error.code === 'MEMORY_STORAGE_LOCK_TIMEOUT');
    assert.equal(fs.statSync(repo.lockPath).isDirectory(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory repository fails closed on a stale file lock without moving it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-dead-file-lock-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file, { lockTimeoutMs: 100 });
  try {
    fs.writeFileSync(repo.lockPath, JSON.stringify({
      token: 'dead-file-owner', pid: 2147483647, hostname: os.hostname(), acquiredAt: new Date(0).toISOString()
    }));
    assert.throws(() => repo.withLock(() => 'must not run'), error => {
      assert.equal(error.code, 'MEMORY_STORAGE_STALE_LOCK');
      assert.equal(error.details.token, 'dead-file-owner');
      return true;
    });
    assert.equal(fs.existsSync(repo.lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(repo.lockPath, 'utf8')).token, 'dead-file-owner');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic memory store initialization keeps the published file private', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-private-store-'));
  const file = path.join(dir, 'memories.json');
  try {
    new JsonMemoryRepository(file);
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode & 0o077, 0, 'memory store must not grant group/other access');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('memory repository fails closed on empty or non-array persisted state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-corrupt-state-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file);

  try {
    for (const invalidContent of ['', '   \n\t', '{"memories":[]}', 'null', '"not-an-array"']) {
      fs.writeFileSync(file, invalidContent, 'utf8');
      assert.throws(
        () => repo.readRaw(),
        error => error.message.startsWith('Memory storage read failed:'),
        'invalid persisted state must be surfaced instead of silently appearing as an empty memory store'
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory repository reports malformed JSON instead of returning an empty store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-malformed-state-'));
  const file = path.join(dir, 'memories.json');
  const repo = new JsonMemoryRepository(file);

  try {
    fs.writeFileSync(file, '[{"id":', 'utf8');
    assert.throws(
      () => repo.findAll('tenant-a', 'personal'),
      error => error.message.startsWith('Memory storage read failed:'),
      'malformed JSON must not be interpreted as an empty memory store'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
