'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ensurePrivateStorageDirectory = require('../../../src/infrastructure/filesystem/private-storage-directory');

function withRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-private-storage-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function spoofOwner(directory, uid, run) {
  const original = fs.lstatSync;
  fs.lstatSync = function (candidate, ...args) {
    const stats = original.call(this, candidate, ...args);
    if (path.resolve(String(candidate)) !== path.resolve(directory)) return stats;
    const spoofed = Object.create(stats);
    Object.defineProperty(spoofed, 'uid', { value: BigInt(uid), enumerable: true });
    return spoofed;
  };
  try { return run(); } finally { fs.lstatSync = original; }
}

test('canonicalizes a trusted symlink ancestor before creating private descendants', () => {
  withRoot(root => {
    const canonicalParent = path.join(root, 'canonical-parent');
    fs.mkdirSync(canonicalParent, { mode: 0o700 });
    const alias = path.join(root, 'platform-alias');
    fs.symlinkSync(canonicalParent, alias, 'dir');

    const resolved = ensurePrivateStorageDirectory(path.join(alias, 'receipts'));
    assert.equal(resolved, path.join(fs.realpathSync(canonicalParent), 'receipts'));
    assert.equal(fs.statSync(resolved).isDirectory(), true);
    assert.equal(fs.statSync(resolved).mode & 0o077, 0);
  });
});

test('rejects an attacker-owned sticky ancestor even though the sticky bit is set', () => {
  withRoot(root => {
    const stickyParent = path.join(root, 'attacker-sticky');
    fs.mkdirSync(stickyParent, { mode: 0o1777 });
    fs.chmodSync(stickyParent, 0o1777);
    const requested = path.join(stickyParent, 'private', 'receipts');

    spoofOwner(stickyParent, process.getuid() + 10000, () => {
      assert.throws(
        () => ensurePrivateStorageDirectory(requested),
        error => error.code === 'PRIVATE_STORAGE_PARENT_UNTRUSTED'
      );
    });
    assert.equal(fs.existsSync(path.join(stickyParent, 'private')), false);
  });
});

test('rejects a writable non-sticky grandparent above a private immediate parent', () => {
  withRoot(root => {
    const grandparent = path.join(root, 'writable-grandparent');
    const parent = path.join(grandparent, 'private-parent');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(grandparent, 0o777);
    fs.chmodSync(parent, 0o700);

    assert.throws(
      () => ensurePrivateStorageDirectory(path.join(parent, 'receipts')),
      error => error.code === 'PRIVATE_STORAGE_PARENT_UNTRUSTED'
    );
    assert.equal(fs.existsSync(path.join(parent, 'receipts')), false);
  });
});

test('accepts a sticky ancestor only when its owner is explicitly trusted', () => {
  withRoot(root => {
    const stickyParent = path.join(root, 'system-sticky');
    fs.mkdirSync(stickyParent, { mode: 0o1777 });
    fs.chmodSync(stickyParent, 0o1777);
    const requested = path.join(stickyParent, 'receipts');

    spoofOwner(stickyParent, 1000, () => {
      const resolved = ensurePrivateStorageDirectory(requested, {
        trustedOwnerUids: [1000]
      });
      assert.equal(resolved, requested);
      assert.equal(fs.statSync(resolved).isDirectory(), true);
    });
  });
});

test('rejects a symlink at the configured storage leaf', () => {
  withRoot(root => {
    const target = path.join(root, 'target');
    const alias = path.join(root, 'storage');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, alias, 'dir');

    assert.throws(
      () => ensurePrivateStorageDirectory(alias),
      error => error.code === 'PRIVATE_STORAGE_DIRECTORY_INVALID'
    );
  });
});

test('rejects a file in the ancestor chain without creating a child', () => {
  withRoot(root => {
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'x');
    const requested = path.join(file, 'receipts');

    assert.throws(
      () => ensurePrivateStorageDirectory(requested),
      error => error.code === 'PRIVATE_STORAGE_PARENT_INVALID'
    );
    assert.equal(fs.existsSync(requested), false);
  });
});

test('repairs an existing service-owned directory only when permission repair is enabled', () => {
  withRoot(root => {
    const directory = path.join(root, 'permissive');
    fs.mkdirSync(directory, { mode: 0o755 });
    fs.chmodSync(directory, 0o755);

    assert.throws(
      () => ensurePrivateStorageDirectory(directory),
      error => error.code === 'PRIVATE_STORAGE_DIRECTORY_PERMISSIONS_INVALID'
    );
    assert.equal(ensurePrivateStorageDirectory(directory, { repairPermissions: true }), directory);
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
  });
});

test('rejects filesystem root as a storage directory', () => {
  assert.throws(
    () => ensurePrivateStorageDirectory(path.parse(process.cwd()).root),
    error => error.code === 'PRIVATE_STORAGE_DIRECTORY_INVALID'
  );
});
