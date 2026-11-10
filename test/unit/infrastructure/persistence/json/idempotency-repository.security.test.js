'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IdempotencyRepository = require('../../../../src/infrastructure/persistence/json/idempotency.repository');
const { MAX_JSON_STORAGE_BYTES } = require('../../../../src/infrastructure/persistence/json/json-file-boundary');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-idempotency-security-'));
  return { directory, filePath: path.join(directory, 'idempotency.json') };
}

test('idempotency JSON storage is private and initializes atomically', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  new IdempotencyRepository(f.filePath);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath, 'utf8')), {});
});

test('idempotency repository rejects a symlinked data file', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath);
  const target = path.join(f.directory, 'outside.json');
  fs.writeFileSync(target, '{}\n', { mode: 0o600 });
  fs.renameSync(f.filePath, target + '.original');
  fs.symlinkSync(target, f.filePath);
  assert.throws(() => repository.read(), error => error.code === 'JSON_STORAGE_CORRUPT');
  assert.equal(fs.readFileSync(target, 'utf8'), '{}\n');
});

test('idempotency repository rejects a hard-linked data file', t => {
  if (process.platform === 'win32') { t.skip('POSIX hard-link count enforcement is unavailable'); return; }
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath);
  fs.linkSync(f.filePath, path.join(f.directory, 'second-link.json'));
  assert.throws(() => repository.read(), error => error.code === 'JSON_STORAGE_CORRUPT');
});

test('idempotency repository rejects oversized state before reading file bytes', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath);
  fs.truncateSync(f.filePath, MAX_JSON_STORAGE_BYTES + 1);
  assert.throws(() => repository.read(), error => error.code === 'JSON_STORAGE_TOO_LARGE');
});

test('idempotency repository rejects a non-object JSON root', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath);
  fs.writeFileSync(f.filePath, '[]\n', { mode: 0o600 });
  assert.throws(() => repository.read(), error => error.code === 'JSON_STORAGE_CORRUPT');
});

test('idempotency repository treats prototype-named operation IDs as ordinary keys', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath);
  for (const operationId of ['__proto__', 'constructor']) {
    const input = {
      executionId: 'execution-' + operationId,
      step: 1,
      tool: 'state.change',
      operationId,
      tenantId: 'local'
    };
    const first = repository.begin(input);
    assert.equal(first.created, true);
    const reused = repository.begin(input);
    assert.equal(reused.created, false);
    assert.equal(reused.record.key, operationId);
    repository.complete(operationId, { committed: true }, 'local');
    assert.equal(repository.findByKey(operationId, 'local').status, 'completed');
  }
});

test('idempotency repository preserves committed data when atomic rename fails', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath);
  const input = {
    executionId: 'execution-1',
    step: 1,
    tool: 'state.change',
    operationId: 'operation-1',
    tenantId: 'tenant-a'
  };
  repository.begin(input);
  const originalRename = fs.renameSync;
  fs.renameSync = function (source, target) {
    if (String(source).includes('.tmp.') && path.resolve(target) === f.filePath) {
      throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    }
    return originalRename.call(this, source, target);
  };
  try {
    assert.throws(
      () => repository.complete('operation-1', { ok: true }, 'tenant-a'),
      error => error.code === 'IDEMPOTENCY_STORAGE_WRITE_FAILED' && error.committed === false
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(repository.findByKey('operation-1', 'tenant-a').status, 'running');
  assert.equal(fs.readdirSync(f.directory).some(name => name.includes('.tmp.')), false);
});

test('idempotency repository does not reclaim a stale lock owned by a dead process', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath, { lockTimeoutMs: 20 });
  fs.mkdirSync(repository.lockPath, { mode: 0o700 });
  const owner = {
    token: 'dead-owner',
    pid: 2147483647,
    hostname: os.hostname(),
    acquiredAt: new Date(0).toISOString()
  };
  fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify(owner));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(repository.lockPath, old, old);

  assert.throws(
    () => repository.withLock(() => assert.fail('stale lock must not be reclaimed')),
    error => error.code === 'IDEMPOTENCY_STORAGE_LOCK_TIMEOUT'
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repository.lockPath, 'owner.json'), 'utf8')), owner);
  assert.equal(fs.existsSync(repository.lockPath), true);
});

test('idempotency repository does not follow a symlink inside a pre-existing lock directory', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath, { lockTimeoutMs: 20 });
  fs.mkdirSync(repository.lockPath, { mode: 0o700 });
  const target = path.join(f.directory, 'outside-owner.json');
  fs.writeFileSync(target, 'preserve');
  const marker = path.join(repository.lockPath, 'owner.attacker.json');
  fs.symlinkSync(target, marker);
  assert.throws(
    () => repository.withLock(() => assert.fail('operation must not run')),
    error => error.code === 'IDEMPOTENCY_STORAGE_LOCK_TIMEOUT'
  );
  assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
});

test('idempotency repository retries an ENOTEMPTY lock-creation race', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new IdempotencyRepository(f.filePath, { lockTimeoutMs: 100 });
  const originalMkdir = fs.mkdirSync;
  let injected = false;
  fs.mkdirSync = function (target, options) {
    if (!injected && path.resolve(String(target)) === repository.lockPath) {
      injected = true;
      originalMkdir.call(fs, target, options);
      originalMkdir.call(fs, path.join(target, 'racer'), { mode: 0o700 });
      fs.rmdirSync(path.join(target, 'racer'));
      fs.rmdirSync(target);
      throw Object.assign(new Error('concurrent lock creator released'), { code: 'ENOTEMPTY' });
    }
    return originalMkdir.call(this, target, options);
  };
  try {
    assert.equal(repository.withLock(() => 'acquired'), 'acquired');
  } finally {
    fs.mkdirSync = originalMkdir;
  }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(repository.lockPath), false);
});

test('idempotency repository rejects a symlink at the configured storage directory', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const real = path.join(f.directory, 'real');
  const alias = path.join(f.directory, 'alias');
  fs.mkdirSync(real, { mode: 0o700 });
  fs.symlinkSync(real, alias, 'dir');
  assert.throws(
    () => new IdempotencyRepository(path.join(alias, 'idempotency.json')),
    error => error.code === 'JSON_STORAGE_DIRECTORY_INVALID'
  );
});
