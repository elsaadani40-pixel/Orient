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

test('rejects a trusted-looking symlink alias when its canonical target has an untrusted owner', () => {
  withRoot(root => {
    const canonicalParent = path.join(root, 'untrusted-canonical-parent');
    fs.mkdirSync(canonicalParent, { mode: 0o700 });
    const alias = path.join(root, 'platform-alias');
    fs.symlinkSync(canonicalParent, alias, 'dir');
    const requested = path.join(alias, 'receipts');

    spoofOwner(canonicalParent, process.getuid() + 10000, () => {
      assert.throws(
        () => ensurePrivateStorageDirectory(requested),
        error => error.code === 'PRIVATE_STORAGE_PARENT_UNTRUSTED'
      );
    });
    assert.equal(fs.existsSync(path.join(canonicalParent, 'receipts')), false);
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


test('allows only exact Android system-owned group-writable ancestors when the app is outside AID_SYSTEM', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidSystemGroupAncestor;
  const stats = { uid: 1000n, gid: 1000n, mode: 0o40771n };
  const identity = {
    platform: 'android',
    processGid: 10259,
    supplementaryGroups: [1077, 3003, 9997, 20259, 50259, 10259]
  };

  for (const directory of ['/data', '/data/data', '/data/user/0']) {
    assert.equal(predicate(directory, stats, identity), true, directory);
  }
});

test('rejects Android system-ancestor exception for non-canonical or other-user paths', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidSystemGroupAncestor;
  const stats = { uid: 1000n, gid: 1000n, mode: 0o40771n };
  const identity = {
    platform: 'android',
    processGid: 10259,
    supplementaryGroups: [10259]
  };

  for (const directory of ['/data/user', '/data/user/10', '/data/local/tmp', '/storage/emulated/0']) {
    assert.equal(predicate(directory, stats, identity), false, directory);
  }
});

test('rejects Android system-ancestor exception when AID_SYSTEM belongs to the process groups', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidSystemGroupAncestor;
  const stats = { uid: 1000n, gid: 1000n, mode: 0o40771n };

  assert.equal(predicate('/data', stats, {
    platform: 'android',
    processGid: 1000,
    supplementaryGroups: []
  }), false);
  assert.equal(predicate('/data', stats, {
    platform: 'android',
    processGid: 10259,
    supplementaryGroups: [1000]
  }), false);
});

test('rejects Android system-ancestor exception for wrong owner, group, or unsafe mode', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidSystemGroupAncestor;
  const identity = {
    platform: 'android',
    processGid: 10259,
    supplementaryGroups: [10259]
  };

  assert.equal(predicate('/data', { uid: 0n, gid: 1000n, mode: 0o40771n }, identity), false);
  assert.equal(predicate('/data', { uid: 1000n, gid: 10259n, mode: 0o40771n }, identity), false);
  assert.equal(predicate('/data', { uid: 1000n, gid: 1000n, mode: 0o40773n }, identity), false);
  assert.equal(predicate('/data', { uid: 1000n, gid: 1000n, mode: 0o41771n }, identity), false);
  assert.equal(predicate('/data', { uid: 1000n, gid: 1000n, mode: 0o40711n }, identity), false);
});

test('allows only the app-private Android files directory with a private app root', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidAppFilesAncestor;
  const candidate = '/data/user/0/com.termux/files';
  const result = predicate(candidate, {
    uid: 10259n, gid: 10259n, mode: 0o40771n
  }, {
    platform: 'android',
    processUid: 10259,
    processGid: 10259,
    parentPath: '/data/user/0/com.termux',
    parentStats: { uid: 10259n, gid: 10259n, mode: 0o40700n }
  });
  assert.equal(result, true);
});

test('rejects Android app-files exception outside the direct application data root', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidAppFilesAncestor;
  const base = {
    platform: 'android',
    processUid: 10259,
    processGid: 10259,
    parentStats: { uid: 10259n, gid: 10259n, mode: 0o40700n }
  };
  const stats = { uid: 10259n, gid: 10259n, mode: 0o40771n };
  assert.equal(predicate('/storage/emulated/0/files', stats, {
    ...base, parentPath: '/storage/emulated/0'
  }), false);
  assert.equal(predicate('/data/user/0/com.termux/cache/files', stats, {
    ...base, parentPath: '/data/user/0/com.termux/cache'
  }), false);
});

test('rejects Android app-files exception for mismatched identity or broader permissions', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidAppFilesAncestor;
  const candidate = '/data/user/0/com.termux/files';
  const base = {
    platform: 'android',
    processUid: 10259,
    processGid: 10259,
    parentPath: '/data/user/0/com.termux',
    parentStats: { uid: 10259n, gid: 10259n, mode: 0o40700n }
  };
  assert.equal(predicate(candidate, { uid: 10260n, gid: 10259n, mode: 0o40771n }, base), false);
  assert.equal(predicate(candidate, { uid: 10259n, gid: 10260n, mode: 0o40771n }, base), false);
  assert.equal(predicate(candidate, { uid: 10259n, gid: 10259n, mode: 0o40773n }, base), false);
  assert.equal(predicate(candidate, { uid: 10259n, gid: 10259n, mode: 0o40771n }, {
    ...base, parentStats: { uid: 10259n, gid: 10259n, mode: 0o40711n }
  }), false);
  assert.equal(predicate(candidate, { uid: 10259n, gid: 10259n, mode: 0o40771n }, {
    ...base, processGid: 1000
  }), false);
});

test('never applies the Android app-files exception on non-Android platforms', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidAppFilesAncestor;
  assert.equal(predicate('/data/user/0/com.termux/files', {
    uid: 10259n, gid: 10259n, mode: 0o40771n
  }, {
    platform: 'linux',
    processUid: 10259,
    processGid: 10259,
    parentPath: '/data/user/0/com.termux',
    parentStats: { uid: 10259n, gid: 10259n, mode: 0o40700n }
  }), false);
});

test('never applies the Android system-ancestor exception on non-Android platforms', () => {
  const predicate = ensurePrivateStorageDirectory.isTrustedAndroidSystemGroupAncestor;
  assert.equal(predicate('/data', { uid: 1000n, gid: 1000n, mode: 0o40771n }, {
    platform: 'linux',
    processGid: 10259,
    supplementaryGroups: [10259]
  }), false);
});
