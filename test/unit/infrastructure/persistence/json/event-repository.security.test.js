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
  const repository = f.create();
  if (typeof fs.constants.O_NOFOLLOW !== 'number') {
    assert.throws(() => repository.read(), error => error.code === 'EVENT_STORAGE_UNSAFE_FILESYSTEM');
    return;
  }
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
  assert.equal(fs.readFileSync(path.join(displacedPath), 'utf8'), undefined);
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
