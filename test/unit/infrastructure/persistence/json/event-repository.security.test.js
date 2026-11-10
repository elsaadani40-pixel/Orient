'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
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


test('constructor fails closed when O_NOFOLLOW is unavailable', t => {
  const modulePath = require.resolve('../../../../../src/infrastructure/persistence/json/event.repository');
  const cachedModule = require.cache[modulePath];
  delete require.cache[modulePath];

  const originalLoad = Module._load;
  const unsupportedFs = Object.create(fs);
  Object.defineProperty(unsupportedFs, 'constants', {
    value: { ...fs.constants, O_NOFOLLOW: undefined }
  });
  let UnsupportedRepository;
  Module._load = function (request, parent, isMain) {
    if (request === 'fs' && parent?.filename === modulePath) return unsupportedFs;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    UnsupportedRepository = require(modulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
    if (cachedModule) require.cache[modulePath] = cachedModule;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-no-nofollow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => new UnsupportedRepository(path.join(root, 'events.json')),
    error => error.code === 'EVENT_STORAGE_UNSAFE_FILESYSTEM'
  );
});

test('bounded reads reject file growth beyond the hard limit after fstat', t => {
  const f = fixture(t);
  const repository = f.create();
  const originalOpenSync = fs.openSync;
  const originalFstatSync = fs.fstatSync;
  const originalReadSync = fs.readSync;
  let targetDescriptor;

  fs.openSync = function (target, ...args) {
    const descriptor = originalOpenSync.call(this, target, ...args);
    if (target === repository.filePath) targetDescriptor = descriptor;
    return descriptor;
  };
  fs.fstatSync = function (descriptor, ...args) {
    const stats = originalFstatSync.call(this, descriptor, ...args);
    if (descriptor !== targetDescriptor) return stats;
    const altered = Object.create(Object.getPrototypeOf(stats));
    Object.assign(altered, stats);
    Object.defineProperty(altered, 'size', { value: 0n });
    return altered;
  };
  fs.readSync = function (descriptor, buffer, offset, length, position) {
    if (descriptor === targetDescriptor) {
      buffer.fill(0x20, offset, offset + length);
      return length;
    }
    return originalReadSync.call(this, descriptor, buffer, offset, length, position);
  };

  try {
    assert.throws(
      () => repository.read(),
      error => error.code === 'EVENT_STORAGE_TOO_LARGE'
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.fstatSync = originalFstatSync;
    fs.readSync = originalReadSync;
  }
});

test('read closes its descriptor after a filesystem read failure', t => {
  const f = fixture(t);
  const repository = f.create();
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const expected = Object.assign(new Error('simulated read failure'), { code: 'EIO' });
  let targetDescriptor;

  fs.openSync = function (target, ...args) {
    const descriptor = originalOpenSync.call(this, target, ...args);
    if (target === repository.filePath) targetDescriptor = descriptor;
    return descriptor;
  };
  fs.readSync = function (descriptor, ...args) {
    if (descriptor === targetDescriptor) throw expected;
    return originalReadSync.call(this, descriptor, ...args);
  };

  try {
    assert.throws(() => repository.read(), error => error === expected);
    assert.throws(
      () => fs.fstatSync(targetDescriptor),
      error => error.code === 'EBADF'
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
  }
});

test('lock initialization closes the owner descriptor when marker writing fails', t => {
  const f = fixture(t);
  const repository = f.create();
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  const expected = Object.assign(new Error('owner marker write failed'), { code: 'EIO' });
  let ownerDescriptor;
  let ownerPath;

  fs.openSync = function (target, ...args) {
    const descriptor = originalOpenSync.call(this, target, ...args);
    if (String(target).startsWith(repository.lockPath + path.sep)) {
      ownerDescriptor = descriptor;
      ownerPath = String(target);
    }
    return descriptor;
  };
  fs.writeFileSync = function (target, ...args) {
    if (target === ownerDescriptor) throw expected;
    return originalWriteFileSync.call(this, target, ...args);
  };

  try {
    assert.throws(() => repository.withLock(() => assert.fail('must not enter')), error => error === expected);
    assert.equal(fs.lstatSync(repository.lockPath).isDirectory(), true);
    assert.equal(fs.lstatSync(ownerPath).isFile(), true);
    assert.throws(
      () => fs.fstatSync(ownerDescriptor),
      error => error.code === 'EBADF'
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.writeFileSync = originalWriteFileSync;
  }
});

test('lock owner descriptor is closed before the protected operation begins', t => {
  const f = fixture(t);
  const repository = f.create();
  const originalOpenSync = fs.openSync;
  let ownerDescriptor;

  fs.openSync = function (target, ...args) {
    const descriptor = originalOpenSync.call(this, target, ...args);
    if (String(target).startsWith(repository.lockPath + path.sep)) ownerDescriptor = descriptor;
    return descriptor;
  };
  try {
    repository.withLock(() => {
      assert.throws(
        () => fs.fstatSync(ownerDescriptor),
        error => error.code === 'EBADF'
      );
    });
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test('atomic writes fsync and close their temporary file descriptor', t => {
  const f = fixture(t);
  const repository = f.create();
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  let temporaryDescriptor;
  let fsyncCalls = 0;

  fs.openSync = function (target, ...args) {
    const descriptor = originalOpenSync.call(this, target, ...args);
    if (String(target).startsWith(repository.filePath + '.tmp.')) temporaryDescriptor = descriptor;
    return descriptor;
  };
  fs.fsyncSync = function (descriptor) {
    fsyncCalls += 1;
    return originalFsyncSync.call(this, descriptor);
  };
  try {
    repository.write([{ id: 'durable-event', type: 'test.created' }]);
    assert.equal(fsyncCalls, 1);
    assert.throws(
      () => fs.fstatSync(temporaryDescriptor),
      error => error.code === 'EBADF'
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
  }
});

test('a safe non-writable parent directory is accepted', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX parent permission checks are not available');
    return;
  }
  const f = fixture(t);
  const parent = path.join(f.root, 'trusted-parent');
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.chmodSync(parent, 0o755);
  const storage = path.join(parent, 'storage');
  const repository = new EventRepository(path.join(storage, 'events.json'));
  assert.equal(repository.directory, storage);
});


test('whitespace-only event files are treated as an empty event log', t => {
  const f = fixture(t);
  const repository = f.create();
  fs.writeFileSync(repository.filePath, '  \n\t  ');
  assert.deepEqual(repository.read(), []);
});

test('tenant-scoped reads tolerate legacy events without a data object', t => {
  const f = fixture(t);
  const repository = f.create();
  repository.write([{ id: 'legacy-without-data', type: 'legacy.event' }]);
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-a' }), []);
});

test('empty lookup keys never match legacy records with empty identity fields', t => {
  const f = fixture(t);
  const repository = f.create();
  repository.write([{
    id: 'legacy-empty-identities',
    aggregateId: '',
    executionId: '',
    goalId: '',
    type: '',
    data: {}
  }]);

  assert.deepEqual(repository.findByExecutionId(''), []);
  assert.deepEqual(repository.findByGoalId(''), []);
  assert.deepEqual(repository.findByAggregateId(''), []);
  assert.deepEqual(repository.findByType(''), []);
});

test('belongsToTenant handles missing events and an intentionally unscoped caller', t => {
  const f = fixture(t);
  const repository = f.create();
  assert.equal(repository.belongsToTenant(undefined, 'tenant-a'), false);
  assert.equal(repository.belongsToTenant({ data: { tenantId: 'tenant-a' } }, null), true);
});

test('unscoped writes preserve the absence of tenant metadata', t => {
  const f = fixture(t);
  const repository = f.create();

  const appended = repository.append({ id: 'unscoped-append', type: 'test.event', data: {} });
  const batch = repository.appendMany([{ id: 'unscoped-batch', type: 'test.event', data: {} }]);
  const mission = repository.appendMissionEvent({
    id: 'unscoped-mission',
    aggregateId: 'unscoped-aggregate',
    type: 'mission.started',
    data: {}
  });

  assert.equal(Object.hasOwn(appended.data, 'tenantId'), false);
  assert.equal(Object.hasOwn(batch[0].data, 'tenantId'), false);
  assert.equal(Object.hasOwn(mission.data, 'tenantId'), false);
});

test('append replay for the same tenant and event id remains idempotent', t => {
  const f = fixture(t);
  const repository = f.create();
  const event = {
    id: 'same-tenant-replay',
    type: 'mission.checkpoint',
    timestamp: '2026-11-10T12:00:00.000Z',
    data: { tenantId: 'tenant-a', checkpoint: 1 }
  };

  const first = repository.append(event, { tenantId: 'tenant-a' });
  const replay = repository.append(event, { tenantId: 'tenant-a' });

  assert.deepEqual(replay, first);
  assert.equal(repository.count(), 1);
});

test('mission event writes reject a missing aggregate id', t => {
  const f = fixture(t);
  const repository = f.create();
  assert.throws(
    () => repository.appendMissionEvent({
      id: 'missing-aggregate-id',
      type: 'mission.started',
      data: {}
    }),
    error => error instanceof TypeError
  );
  assert.equal(repository.count(), 0);
});

test('event normalization rejects primitive events and discards non-object data', t => {
  const f = fixture(t);
  const repository = f.create();

  assert.throws(() => repository.append(null), TypeError);
  assert.throws(() => repository.append('not-an-event'), TypeError);

  const normalized = repository.append({
    id: 'non-object-data',
    type: 'test.event',
    data: 'not-an-object'
  });
  assert.deepEqual(normalized.data, {});
});

test('appendMany rejects array-like objects instead of treating them as empty batches', t => {
  const f = fixture(t);
  const repository = f.create();
  assert.throws(() => repository.appendMany({ length: 0 }), TypeError);
  assert.equal(repository.count(), 0);
});


test('storage fails closed if permission tightening does not make the directory private', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-chmod-noop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = path.join(root, 'storage');
  fs.mkdirSync(storage, { mode: 0o755 });
  fs.chmodSync(storage, 0o755);

  const originalChmodSync = fs.chmodSync;
  fs.chmodSync = function (target, mode, ...args) {
    if (target === storage && mode === 0o700) return;
    return originalChmodSync.call(this, target, mode, ...args);
  };

  try {
    assert.throws(
      () => new EventRepository(path.join(storage, 'events.json')),
      error => error.code === 'EVENT_STORAGE_DIRECTORY_PERMISSIONS_INVALID'
    );
  } finally {
    fs.chmodSync = originalChmodSync;
  }
});

test('lock acquisition never follows a pre-existing owner-marker symlink', t => {
  const f = fixture(t);
  const repository = f.create();
  const outside = path.join(f.root, 'outside-owner-target');
  fs.writeFileSync(outside, 'outside-data-must-remain-unchanged');

  const token = 'fixed-owner-token';
  const ownerPath = path.join(repository.lockPath, 'owner.' + token + '.json');
  const originalRandomUUID = crypto.randomUUID;
  const originalMkdirSync = fs.mkdirSync;

  crypto.randomUUID = () => token;
  fs.mkdirSync = function (target, ...args) {
    const result = originalMkdirSync.call(this, target, ...args);
    if (target === repository.lockPath) fs.symlinkSync(outside, ownerPath);
    return result;
  };

  try {
    assert.throws(
      () => repository.withLock(() => assert.fail('must not acquire a symlinked owner marker')),
      error => error.code === 'EEXIST'
    );
  } finally {
    crypto.randomUUID = originalRandomUUID;
    fs.mkdirSync = originalMkdirSync;
  }

  assert.equal(fs.lstatSync(ownerPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-data-must-remain-unchanged');
  assert.equal(fs.existsSync(repository.lockPath), true);
});
