'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventRepository = require('../../../../../src/infrastructure/persistence/json/event.repository');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-repository-'));
  fs.chmodSync(root, 0o700);
  t.after(() => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    filePath: path.join(root, 'events.json'),
    create: () => new EventRepository(path.join(root, 'events.json'), options)
  };
}

test('JSON EventRepository requires a private canonical local data directory', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX directory ownership and mode checks are not available');
    return;
  }
  const f = fixture(t);
  const repository = f.create();
  assert.equal(repository.append({ id: 'event-private', type: 'test.created' }).id, 'event-private');
  assert.equal((fs.statSync(f.root).mode & 0o777), 0o700);
});

test('event reads reject symbolic links without following them', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'target.json'), '[]\\n', { mode: 0o600 });
  fs.symlinkSync(path.join(f.root, 'target.json'), f.filePath);
  if (typeof fs.constants.O_NOFOLLOW !== 'number') {
    assert.throws(() => f.create(), error => error.code === 'EVENT_STORAGE_UNSAFE_FILESYSTEM');
    return;
  }
  const repository = f.create();
  assert.throws(() => repository.read(), error => error.code === 'EVENT_STORAGE_CORRUPT');
});

test('stale and legacy lock directories fail closed without rename or deletion', t => {
  const f = fixture(t, { lockTimeoutMs: 10 });
  const repository = f.create();
  fs.mkdirSync(repository.lockPath, { mode: 0o700 });
  const ownerPath = path.join(repository.lockPath, 'owner.json');
  const marker = JSON.stringify({ token: 'old-owner', pid: 2147483647, acquiredAt: new Date(0).toISOString() });
  fs.writeFileSync(ownerPath, marker, { mode: 0o600 });

  assert.throws(
    () => repository.withLock(() => assert.fail('must not enter while an existing lock is present')),
    error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
  );
  assert.equal(fs.readFileSync(ownerPath, 'utf8'), marker);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.includes('.stale.')), []);
});

test('lock release never removes a replacement lock directory', t => {
  const f = fixture(t);
  const repository = f.create();
  const replacementMarker = 'owner.successor.json';
  const displacedPath = repository.lockPath + '.displaced';

  assert.throws(() => repository.withLock(() => {
    fs.renameSync(repository.lockPath, displacedPath);
    fs.mkdirSync(repository.lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(repository.lockPath, replacementMarker), 'successor', { mode: 0o600 });
  }), error => error.code === 'ENOENT');

  assert.equal(fs.readFileSync(path.join(repository.lockPath, replacementMarker), 'utf8'), 'successor');
  assert.equal(fs.readdirSync(displacedPath).some(name => name.startsWith('owner.')), true);
});

test('lock initialization failure leaves the incomplete lock for operator recovery', t => {
  const f = fixture(t);
  const repository = f.create();
  const originalOpenSync = fs.openSync;
  const expected = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  fs.openSync = function (filePath, ...args) {
    if (String(filePath).startsWith(repository.lockPath + path.sep)) throw expected;
    return originalOpenSync.call(this, filePath, ...args);
  };
  try {
    assert.throws(() => repository.withLock(() => {}), error => error === expected);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(fs.lstatSync(repository.lockPath).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(repository.lockPath), []);
});

test('event reads preserve operational filesystem errors', t => {
  const f = fixture(t);
  const repository = f.create();
  const originalOpenSync = fs.openSync;
  const expected = Object.assign(new Error('storage unavailable'), { code: 'EIO' });
  fs.openSync = function (filePath, ...args) {
    if (filePath === repository.filePath) throw expected;
    return originalOpenSync.call(this, filePath, ...args);
  };
  try {
    assert.throws(() => repository.read(), error => error === expected && error.code === 'EIO');
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test('event writes use unique exclusive temporary files and preserve append behavior', t => {
  const f = fixture(t);
  const repository = f.create();
  repository.append({ id: 'event-one', type: 'test.created' }, { tenantId: 'tenant-a' });
  repository.append({ id: 'event-two', type: 'test.updated' }, { tenantId: 'tenant-a' });
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-a' }).map(event => event.id), ['event-one', 'event-two']);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.includes('.tmp.')), []);
});


test('event repository rejects a symlinked data directory', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'directory-alias');
  fs.symlinkSync(f.root, alias, 'dir');
  assert.throws(
    () => new EventRepository(path.join(alias, 'events.json')),
    error => error.code === 'EVENT_STORAGE_DIRECTORY_INVALID'
  );
});


test('existing permissive storage directories are tightened to mode 0700', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX directory mode checks are not available');
    return;
  }
  const f = fixture(t);
  fs.chmodSync(f.root, 0o755);
  const repository = f.create();
  assert.equal((fs.statSync(repository.directory).mode & 0o777), 0o700);
});

test('storage rejects a parent directory writable by other users without a sticky bit', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX parent permission checks are not available');
    return;
  }
  const f = fixture(t);
  const parent = path.join(f.root, 'untrusted-parent');
  const storage = path.join(parent, 'storage');
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.chmodSync(parent, 0o777);
  try {
    assert.throws(
      () => new EventRepository(path.join(storage, 'events.json')),
      error => error.code === 'EVENT_STORAGE_PARENT_UNTRUSTED'
    );
  } finally {
    fs.chmodSync(parent, 0o700);
  }
});

test('storage rejects a directory not owned by the application user', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX directory ownership checks are not available');
    return;
  }
  const f = fixture(t);
  const originalLstatSync = fs.lstatSync;
  fs.lstatSync = function (target, ...args) {
    const stats = originalLstatSync.call(this, target, ...args);
    if (path.resolve(String(target)) !== path.resolve(f.root)) return stats;
    const altered = Object.create(Object.getPrototypeOf(stats));
    Object.assign(altered, stats);
    Object.defineProperty(altered, 'uid', { value: BigInt(process.getuid()) + 1n });
    return altered;
  };
  try {
    assert.throws(
      () => f.create(),
      error => error.code === 'EVENT_STORAGE_DIRECTORY_OWNER_INVALID'
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }
});

test('event file and active lock use private filesystem permissions', t => {
  if (process.platform === 'win32') {
    t.skip('POSIX filesystem mode checks are not available');
    return;
  }
  const f = fixture(t);
  const repository = f.create();
  assert.equal((fs.statSync(repository.filePath).mode & 0o777), 0o600);
  repository.withLock(() => {
    assert.equal((fs.statSync(repository.lockPath).mode & 0o777), 0o700);
    const ownerName = fs.readdirSync(repository.lockPath).find(name => name.startsWith('owner.'));
    assert.ok(ownerName);
    assert.equal((fs.statSync(path.join(repository.lockPath, ownerName)).mode & 0o777), 0o600);
  });
});
