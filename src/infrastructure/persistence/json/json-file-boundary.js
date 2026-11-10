'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_JSON_STORAGE_BYTES = 64 * 1024 * 1024;

function storageError(message, code) {
  return Object.assign(new Error(message), { code });
}

function prepareStoragePath(filePath) {
  if (typeof fs.constants.O_NOFOLLOW !== 'number') {
    throw storageError('Safe JSON storage is unsupported on this platform', 'JSON_STORAGE_UNSAFE_FILESYSTEM');
  }

  const configuredDirectory = path.resolve(path.dirname(filePath));
  fs.mkdirSync(configuredDirectory, { recursive: true, mode: 0o700 });
  const configuredStats = fs.lstatSync(configuredDirectory, { bigint: true });
  if (!configuredStats.isDirectory() || configuredStats.isSymbolicLink()) {
    throw storageError('JSON storage directory must not be a symbolic link', 'JSON_STORAGE_DIRECTORY_INVALID');
  }

  const directory = fs.realpathSync(configuredDirectory);
  const directoryStats = fs.lstatSync(directory, { bigint: true });
  const parentDirectory = path.dirname(directory);
  const parentStats = fs.lstatSync(parentDirectory, { bigint: true });
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
      !parentStats.isDirectory() || parentStats.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory ||
      fs.realpathSync(parentDirectory) !== parentDirectory) {
    throw storageError('JSON storage directory must be a real canonical directory', 'JSON_STORAGE_DIRECTORY_INVALID');
  }

  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (directoryStats.uid !== BigInt(process.getuid())) {
      throw storageError('JSON storage directory must be owned by the application user', 'JSON_STORAGE_DIRECTORY_OWNER_INVALID');
    }
    const parentMode = parentStats.mode & 0o7777n;
    if ((parentMode & 0o022n) !== 0n && (parentMode & 0o1000n) === 0n) {
      throw storageError('JSON storage parent is writable by other users without sticky-bit protection', 'JSON_STORAGE_PARENT_UNTRUSTED');
    }
    if ((directoryStats.mode & 0o077n) !== 0n) fs.chmodSync(directory, 0o700);
    const privateStats = fs.lstatSync(directory, { bigint: true });
    if ((privateStats.mode & 0o077n) !== 0n) {
      throw storageError('JSON storage directory must be private (mode 0700)', 'JSON_STORAGE_DIRECTORY_PERMISSIONS_INVALID');
    }
  }

  return {
    directory,
    filePath: path.join(directory, path.basename(filePath)),
    lockPath: path.join(directory, path.basename(filePath) + '.lock')
  };
}

function fsyncDirectory(directory, { allowUnsupported = false } = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (allowUnsupported && ['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) return;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function initializeJsonFile(filePath, initialPayload, directory, options = {}) {
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, initialPayload, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (created) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    if (error.code === 'EEXIST') return false;
    throw error;
  }

  fsyncDirectory(directory, options);
  return true;
}

function readBoundedFile(descriptor, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const count = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
    if (count === 0) break;
    total += count;
  }
  if (total > maxBytes) {
    throw storageError('JSON storage file exceeds its maximum permitted size', 'JSON_STORAGE_TOO_LARGE');
  }
  return buffer.subarray(0, total).toString('utf8');
}

function readJsonFile(filePath, {
  label = 'JSON',
  rootType = 'array',
  emptyValue = null,
  maxBytes = MAX_JSON_STORAGE_BYTES
} = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw storageError(`${label} storage must be a single-link regular file`, 'JSON_STORAGE_CORRUPT');
    }
    if (stats.size > maxBytes) {
      throw storageError(`${label} storage exceeds its maximum permitted size`, 'JSON_STORAGE_TOO_LARGE');
    }
    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      if (stats.uid !== process.getuid()) {
        throw storageError(`${label} storage must be owned by the application user`, 'JSON_STORAGE_FILE_OWNER_INVALID');
      }
      if ((stats.mode & 0o077) !== 0) {
        fs.fchmodSync(descriptor, 0o600);
        if ((fs.fstatSync(descriptor).mode & 0o077) !== 0) {
          throw storageError(`${label} storage must be private (mode 0600)`, 'JSON_STORAGE_FILE_PERMISSIONS_INVALID');
        }
      }
    }

    const raw = readBoundedFile(descriptor, maxBytes);
    if (!raw.trim()) return typeof emptyValue === 'function' ? emptyValue() : emptyValue;

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) {
      if (error instanceof SyntaxError) {
        throw storageError(`${label} storage contains invalid JSON`, 'JSON_STORAGE_CORRUPT');
      }
      throw error;
    }
    const validRoot = rootType === 'array'
      ? Array.isArray(parsed)
      : rootType === 'object' && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    if (!validRoot) {
      throw storageError(`${label} storage root must be a ${rootType}`, 'JSON_STORAGE_CORRUPT');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EMLINK') {
      throw storageError(`${label} storage must not be a symbolic link`, 'JSON_STORAGE_CORRUPT');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeAtomic(filePath, payload, directory, {
  label = 'JSON',
  allowUnsupportedDirectoryFsync = false
} = {}) {
  const temporaryFile = filePath + '.tmp.' + crypto.randomUUID();
  let descriptor;
  let created = false;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, payload, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    fs.renameSync(temporaryFile, filePath);
    renamed = true;
    created = false;
    fsyncDirectory(directory, { allowUnsupported: allowUnsupportedDirectoryFsync });
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (created) {
      try { fs.unlinkSync(temporaryFile); } catch {}
    }
    throw Object.assign(new Error(`${label} storage write failed: ${error.message}`), {
      code: `${label.toUpperCase()}_STORAGE_WRITE_FAILED`,
      committed: renamed,
      cause: error
    });
  }
}

function withDirectoryLock(lockPath, timeoutMs, timeoutCode, operation) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const token = crypto.randomUUID();
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      if (Date.now() >= deadline) {
        throw storageError('JSON storage lock timeout; existing lock was left untouched', timeoutCode);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }

    const ownerPath = path.join(lockPath, 'owner.' + token + '.json');
    let descriptor;
    let markerCreated = false;
    try {
      descriptor = fs.openSync(ownerPath, 'wx', 0o600);
      markerCreated = true;
      fs.writeFileSync(descriptor, JSON.stringify({
        token,
        pid: process.pid,
        hostname: require('node:os').hostname(),
        acquiredAt: new Date().toISOString()
      }) + '\n', 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (markerCreated) {
        try { fs.unlinkSync(ownerPath); } catch {}
      }
      try { fs.rmdirSync(lockPath); } catch {}
      throw error;
    }

    try {
      return operation();
    } finally {
      fs.unlinkSync(ownerPath);
      fs.rmdirSync(lockPath);
    }
  }
}

module.exports = {
  MAX_JSON_STORAGE_BYTES,
  prepareStoragePath,
  initializeJsonFile,
  readJsonFile,
  writeAtomic,
  withDirectoryLock
};
