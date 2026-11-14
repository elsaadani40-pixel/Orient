'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function defaultTrustedOwners(serviceUid) {
  const owners = new Set([0n, serviceUid]);
  const androidRuntime = process.platform === 'android' ||
    (process.env.ANDROID_ROOT === '/system' && fs.existsSync('/system/build.prop'));
  if (androidRuntime) owners.add(1000n); // Android AID_SYSTEM owns platform path ancestors.
  return owners;
}

function ensurePrivateStorageDirectory(directory, {
  mode = 0o700,
  repairPermissions = false,
  trustedOwnerUids,
  errorCodes = {}
} = {}) {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new TypeError('directory is required');
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new TypeError('mode must be a valid POSIX permission mode');
  }

  const codes = {
    directoryInvalid: 'PRIVATE_STORAGE_DIRECTORY_INVALID',
    directoryOwnerInvalid: 'PRIVATE_STORAGE_DIRECTORY_OWNER_INVALID',
    directoryPermissionsInvalid: 'PRIVATE_STORAGE_DIRECTORY_PERMISSIONS_INVALID',
    parentInvalid: 'PRIVATE_STORAGE_PARENT_INVALID',
    parentUntrusted: 'PRIVATE_STORAGE_PARENT_UNTRUSTED',
    ...errorCodes
  };
  const requested = path.resolve(directory);
  const root = path.parse(requested).root;
  if (requested === root) {
    fail('Filesystem root cannot be used as private application storage', codes.directoryInvalid);
  }

  const hasPosixIdentity = process.platform !== 'win32' &&
    typeof process.getuid === 'function';
  const serviceUid = hasPosixIdentity ? BigInt(process.getuid()) : null;
  const trustedOwners = hasPosixIdentity
    ? (trustedOwnerUids
      ? new Set([...trustedOwnerUids].map(value => BigInt(value)).concat([0n, serviceUid]))
      : defaultTrustedOwners(serviceUid))
    : null;

  // Reject a symlink at the configured leaf, but resolve trusted platform
  // aliases in its ancestors (notably Android /data/data) before using paths.
  let leafStats = null;
  try {
    leafStats = fs.lstatSync(requested, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (leafStats?.isSymbolicLink()) {
    fail('Private application storage leaf must not be a symbolic link', codes.directoryInvalid);
  }
  if (leafStats && !leafStats.isDirectory()) {
    fail('Private application storage path must be a directory', codes.directoryInvalid);
  }

  // Find the nearest existing ancestor. Existing ancestor symlinks are resolved
  // to their canonical target; no descendant is created through the alias.
  let existing = requested;
  const missing = [];
  while (true) {
    try {
      const stats = fs.lstatSync(existing, { bigint: true });
      if (stats.isSymbolicLink()) {
        const followed = fs.statSync(existing, { bigint: true });
        if (!followed.isDirectory()) {
          fail('Private storage ancestor symlink must resolve to a directory', codes.parentInvalid);
        }
      } else if (!stats.isDirectory()) {
        fail('Private storage ancestor must be a directory', codes.parentInvalid);
      }
      const canonical = fs.realpathSync(existing);
      const followed = fs.statSync(canonical, { bigint: true });
      if (!followed.isDirectory()) {
        fail('Private storage canonical ancestor must be a directory', codes.parentInvalid);
      }
      existing = canonical;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  const validateDirectory = (candidate, isTarget) => {
    const stats = fs.lstatSync(candidate, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink() ||
        fs.realpathSync(candidate) !== candidate) {
      fail('Private storage path contains a non-directory, symlink, or non-canonical component',
        isTarget ? codes.directoryInvalid : codes.parentInvalid);
    }

    if (!hasPosixIdentity) return;

    if (isTarget) {
      if (stats.uid !== serviceUid) {
        fail('Private storage directory must be owned by the application user', codes.directoryOwnerInvalid);
      }
      if ((stats.mode & 0o077n) !== 0n) {
        if (!repairPermissions) {
          fail('Private storage directory must not be accessible by group or other users', codes.directoryPermissionsInvalid);
        }
        fs.chmodSync(candidate, mode);
        const privateStats = fs.lstatSync(candidate, { bigint: true });
        if (privateStats.uid !== serviceUid || (privateStats.mode & 0o077n) !== 0n) {
          fail('Private storage directory permissions could not be secured', codes.directoryPermissionsInvalid);
        }
      }
      return;
    }

    if (!trustedOwners.has(stats.uid)) {
      fail('Private storage ancestor is not owned by a trusted principal', codes.parentUntrusted);
    }
    const ancestorMode = stats.mode & 0o7777n;
    if ((ancestorMode & 0o022n) !== 0n && (ancestorMode & 0o1000n) === 0n) {
      fail('Private storage ancestor is writable by group or other users without sticky-bit protection', codes.parentUntrusted);
    }
  };

  // Validate the complete canonical ancestor chain before creating descendants.
  const existingRoot = path.parse(existing).root;
  const existingComponents = existing.slice(existingRoot.length).split(path.sep).filter(Boolean);
  let current = existingRoot;
  validateDirectory(current, false);
  for (const component of existingComponents) {
    current = path.join(current, component);
    const isTarget = missing.length === 0 && current === existing;
    validateDirectory(current, isTarget);
  }

  // Create missing components one at a time beneath the validated canonical
  // parent, then validate each newly created or concurrently created directory.
  for (let index = 0; index < missing.length; index += 1) {
    const next = path.join(current, missing[index]);
    try {
      fs.mkdirSync(next, { mode });
      syncDirectory(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const isTarget = index === missing.length - 1;
    validateDirectory(next, isTarget);
    current = next;
  }

  if (missing.length === 0 && current !== existing) {
    fail('Private storage directory resolution did not reach its canonical target', codes.directoryInvalid);
  }
  return current;
}

module.exports = ensurePrivateStorageDirectory;
