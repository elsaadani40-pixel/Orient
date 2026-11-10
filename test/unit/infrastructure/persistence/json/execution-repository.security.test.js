'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExecutionRepository = require('../../../../src/infrastructure/persistence/json/execution.repository');
const { MAX_JSON_STORAGE_BYTES } = require('../../../../src/infrastructure/persistence/json/json-file-boundary');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-execution-security-'));
  return { directory, filePath: path.join(directory, 'executions.json') };
}

test('execution JSON storage is private and initializes atomically', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  new ExecutionRepository(f.filePath);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath, 'utf8')), []);
});

test('execution repository rejects a symlinked data file', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(f.filePath);
  const target = path.join(f.directory, 'outside.json');
  fs.writeFileSync(target, '[]\n', { mode: 0o600 });
  fs.renameSync(f.filePath, target + '.original');
  fs.symlinkSync(target, f.filePath);
  assert.throws(() => repository.readRaw(), error => error.code === 'JSON_STORAGE_CORRUPT');
  assert.equal(fs.readFileSync(target, 'utf8'), '[]\n');
});

test('execution repository rejects a hard-linked data file', t => {
  if (process.platform === 'win32') { t.skip('POSIX hard-link count enforcement is unavailable'); return; }
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(f.filePath);
  fs.linkSync(f.filePath, path.join(f.directory, 'second-link.json'));
  assert.throws(() => repository.readRaw(), error => error.code === 'JSON_STORAGE_CORRUPT');
});

test('execution repository rejects oversized state before reading file bytes', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(f.filePath);
  fs.truncateSync(f.filePath, MAX_JSON_STORAGE_BYTES + 1);
  assert.throws(() => repository.readRaw(), error => error.code === 'JSON_STORAGE_TOO_LARGE');
});

test('execution repository rejects a non-array JSON root', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(f.filePath);
  fs.writeFileSync(f.filePath, '{}\n', { mode: 0o600 });
  assert.throws(() => repository.readRaw(), error => error.code === 'JSON_STORAGE_CORRUPT');
});

test('execution repository tightens an existing data file to mode 0600', t => {
  if (process.platform === 'win32') { t.skip('POSIX mode enforcement is unavailable'); return; }
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(f.filePath);
  fs.chmodSync(f.filePath, 0o644);
  assert.deepEqual(repository.readRaw(), []);
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
});

test('execution repository preserves committed data when atomic rename fails', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(f.filePath);
  const originalRename = fs.renameSync;
  fs.renameSync = function (source, target) {
    if (String(source).includes('.tmp.') && path.resolve(target) === f.filePath) {
      throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    }
    return originalRename.call(this, source, target);
  };
  try {
    assert.throws(
      () => repository.write([{ executionId: 'not-committed' }]),
      error => error.code === 'EXECUTION_STORAGE_WRITE_FAILED' && error.committed === false
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(repository.readRaw(), []);
  assert.equal(fs.readdirSync(f.directory).some(name => name.includes('.tmp.')), false);
});

test('execution repository accepts a concurrent creator winning initial file creation', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = function (target, flags, mode) {
    if (!injected && path.resolve(String(target)) === f.filePath && flags === 'wx') {
      injected = true;
      const descriptor = originalOpen.call(fs, target, flags, mode);
      fs.writeFileSync(descriptor, '[]\n', 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      throw Object.assign(new Error('concurrent creator won'), { code: 'EEXIST' });
    }
    return originalOpen.call(this, target, flags, mode);
  };
  try {
    assert.doesNotThrow(() => new ExecutionRepository(f.filePath));
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(injected, true);
  assert.deepEqual(new ExecutionRepository(f.filePath).readRaw(), []);
});

test('execution repository retries an ENOTEMPTY lock-creation race', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(f.filePath, { lockTimeoutMs: 100 });
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

test('execution repository does not follow a symlink inside a pre-existing lock directory', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(f.filePath, { lockTimeoutMs: 20 });
  fs.mkdirSync(repository.lockPath, { mode: 0o700 });
  const target = path.join(f.directory, 'outside-owner.json');
  fs.writeFileSync(target, 'preserve');
  const marker = path.join(repository.lockPath, 'owner.attacker.json');
  fs.symlinkSync(target, marker);
  assert.throws(
    () => repository.withLock(() => assert.fail('operation must not run')),
    error => error.code === 'EXECUTION_STORAGE_LOCK_TIMEOUT'
  );
  assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
});

test('execution repository rejects a symlink at the configured storage directory', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const real = path.join(f.directory, 'real');
  const alias = path.join(f.directory, 'alias');
  fs.mkdirSync(real, { mode: 0o700 });
  fs.symlinkSync(real, alias, 'dir');
  assert.throws(
    () => new ExecutionRepository(path.join(alias, 'executions.json')),
    error => error.code === 'JSON_STORAGE_DIRECTORY_INVALID'
  );
});

test('execution repository rejects an untrusted writable parent directory', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX parent directory checks are unavailable');
    return;
  }
  const f = fixture();
  t.after(() => { fs.chmodSync(f.directory, 0o700); fs.rmSync(f.directory, { recursive: true, force: true }); });
  fs.chmodSync(f.directory, 0o777);
  assert.throws(
    () => new ExecutionRepository(path.join(f.directory, 'storage', 'executions.json')),
    error => error.code === 'JSON_STORAGE_PARENT_UNTRUSTED'
  );
});
