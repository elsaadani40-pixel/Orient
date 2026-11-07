'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function validIdentity(value) {
  return value && typeof value.operationId === 'string' &&
    value.operationId.length > 0 && value.operationId.length <= 256 &&
    typeof value.tenantId === 'string' &&
    value.tenantId.length > 0 && value.tenantId.length <= 128;
}

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Durable, tenant-scoped receipts for verified project changes.
 * The receipt directory belongs to application data, never to the workspace.
 * Writers use exclusive locks; stale local-owner locks are quarantined only when the process is gone.
 */
class ProjectOperationReceiptStore {
  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new TypeError('directory is required');
    }
    this.directory = path.resolve(directory);
  }

  receiptPath(operationId, tenantId) {
    if (!validIdentity({ operationId, tenantId })) {
      fail('Operation receipt identity is invalid', 'PROJECT_OPERATION_RECEIPT_IDENTITY_INVALID');
    }
    return path.join(this.directory, digest(tenantId + '\0' + operationId) + '.json');
  }

  ensureDirectory() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() ||
        fs.realpathSync(this.directory) !== this.directory) {
      fail('Operation receipt directory is not a real, canonical directory', 'PROJECT_OPERATION_RECEIPT_DIRECTORY_INVALID');
    }
  }

  intentPath(operationId, tenantId) {
    return this.receiptPath(operationId, tenantId) + '.intent.json';
  }

  readIntent({ operationId, tenantId }) {
    const filePath = this.intentPath(operationId, tenantId);
    let intent;
    let fd;
    try {
      // Never inspect then reopen by pathname: that creates a TOCTOU window.
      // Require O_NOFOLLOW so unsupported platforms fail closed instead of
      // following a substituted symlink.
      if (typeof fs.constants.O_NOFOLLOW !== 'number') {
        fail('Safe intent-file reads are unsupported on this platform', 'PROJECT_OPERATION_INTENT_UNSAFE_FILESYSTEM');
      }
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const openedStats = fs.fstatSync(fd);
      if (!openedStats.isFile()) {
        fail('Project operation intent is not a regular file', 'PROJECT_OPERATION_INTENT_CORRUPT');
      }
      intent = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ELOOP') {
        fail('Project operation intent must not be a symbolic link', 'PROJECT_OPERATION_INTENT_CORRUPT');
      }
      if (error.code === 'PROJECT_OPERATION_INTENT_UNSAFE_FILESYSTEM' ||
          error.code === 'PROJECT_OPERATION_INTENT_CORRUPT') throw error;
      const invalid = new Error('Project operation intent is not valid or could not be read safely');
      invalid.code = 'PROJECT_OPERATION_INTENT_CORRUPT';
      invalid.cause = error;
      throw invalid;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }

    if (!intent || intent.version !== 1 || intent.status !== 'pending' ||
        intent.operationId !== operationId || intent.tenantId !== tenantId ||
        typeof intent.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(intent.workspaceId) ||
        typeof intent.changeSetHash !== 'string' || !/^[a-f0-9]{64}$/.test(intent.changeSetHash) ||
        typeof intent.recordedAt !== 'string') {
      fail('Project operation intent schema or identity is invalid', 'PROJECT_OPERATION_INTENT_CORRUPT');
    }
    return intent;
  }

  beginIntent({ operationId, tenantId, workspaceId, changeSetHash }) {
    if (!validIdentity({ operationId, tenantId }) ||
        typeof workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(workspaceId) ||
        typeof changeSetHash !== 'string' || !/^[a-f0-9]{64}$/.test(changeSetHash)) {
      fail('Project operation intent identity is invalid', 'PROJECT_OPERATION_INTENT_INVALID');
    }

    this.ensureDirectory();
    const filePath = this.intentPath(operationId, tenantId);
    const intent = {
      version: 1,
      status: 'pending',
      operationId,
      tenantId,
      workspaceId,
      changeSetHash,
      recordedAt: new Date().toISOString()
    };
    let fd;
    try {
      fd = fs.openSync(filePath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(intent) + '\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      syncDirectory(this.directory);
      return { created: true, intent };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      if (error.code !== 'EEXIST') {
        // Do not unlink by pathname after a failed write: another actor could
        // replace the path between creation and cleanup. A partial intent is
        // deliberately left in place and causes fail-closed recovery.
        throw error;
      }
    }

    const existing = this.readIntent({ operationId, tenantId });
    if (!existing) {
      fail('Project operation intent disappeared during reservation', 'PROJECT_OPERATION_INTENT_CONFLICT');
    }
    if (existing.workspaceId !== workspaceId || existing.changeSetHash !== changeSetHash) {
      fail('Operation ID is already bound to a different pending project change', 'PROJECT_OPERATION_INTENT_IDENTITY_CONFLICT');
    }
    return { created: false, intent: existing };
  }

  // Pending intent files are intentionally retained after a receipt is committed.
  // The verified receipt is authoritative; deleting by pathname after a separate
  // identity check would introduce a time-of-check/time-of-use race.
  read({ operationId, tenantId }) {
    const filePath = this.receiptPath(operationId, tenantId);
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
      fail('Safe receipt-file reads are unsupported on this platform', 'PROJECT_OPERATION_RECEIPT_UNSAFE_FILESYSTEM');
    }

    let descriptor;
    let raw;
    try {
      // Open once without following symlinks, then validate and read that exact
      // file descriptor. A pathname replacement cannot redirect this read.
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const openedStats = fs.fstatSync(descriptor);
      if (!openedStats.isFile()) {
        fail('Project operation receipt is not a regular file', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
      }
      raw = fs.readFileSync(descriptor, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ELOOP') {
        fail('Project operation receipt must not be a symbolic link', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
      }
      if (error.code === 'PROJECT_OPERATION_RECEIPT_CORRUPT' ||
          error.code === 'PROJECT_OPERATION_RECEIPT_UNSAFE_FILESYSTEM') throw error;
      const invalid = new Error('Project operation receipt could not be read safely');
      invalid.code = 'PROJECT_OPERATION_RECEIPT_CORRUPT';
      invalid.cause = error;
      throw invalid;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }

    let receipt;
    try {
      receipt = JSON.parse(raw);
    } catch (error) {
      const corrupt = new Error('Project operation receipt is not valid JSON');
      corrupt.code = 'PROJECT_OPERATION_RECEIPT_CORRUPT';
      corrupt.cause = error;
      throw corrupt;
    }

    if (!receipt || receipt.version !== 1 ||
        receipt.operationId !== operationId ||
        receipt.tenantId !== tenantId ||
        typeof receipt.workspaceId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.workspaceId) ||
        typeof receipt.changeSetHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.changeSetHash) ||
        typeof receipt.recordedAt !== 'string' ||
        !receipt.result || typeof receipt.result !== 'object' ||
        receipt.result.status !== 'verified' ||
        receipt.result.verification?.status !== 'passed' ||
        receipt.result.verification?.failed !== 0) {
      fail('Project operation receipt schema or identity is invalid', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
    }

    return receipt;
  }

  write({ operationId, tenantId, workspaceId, changeSetHash, result }) {
    if (!validIdentity({ operationId, tenantId }) ||
        typeof workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(workspaceId) ||
        typeof changeSetHash !== 'string' || !/^[a-f0-9]{64}$/.test(changeSetHash) ||
        !result || result.status !== 'verified' ||
        result.verification?.status !== 'passed' ||
        result.verification?.failed !== 0) {
      fail('Only a verified project operation can be receipted', 'PROJECT_OPERATION_RECEIPT_INVALID');
    }

    this.ensureDirectory();
    const filePath = this.receiptPath(operationId, tenantId);
    const lockPath = filePath + '.lock';
    const token = crypto.randomUUID();
    const ownerPath = path.join(lockPath, 'owner.' + token + '.json');
    let acquired = false;

    try {
      // A directory is the atomic lock primitive. Unlike check-then-unlink of
      // a lock file, rmdir succeeds only while this exact directory is empty.
      fs.mkdirSync(lockPath, 0o700);
      const ownerFd = fs.openSync(ownerPath, 'wx', 0o600);
      try {
        fs.writeFileSync(ownerFd, JSON.stringify({
          token,
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        }) + '\n', 'utf8');
        fs.fsyncSync(ownerFd);
      } finally {
        fs.closeSync(ownerFd);
      }
      syncDirectory(this.directory);
      acquired = true;
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
        fail('Project operation receipt is locked; refusing unsafe stale-lock reclamation', 'PROJECT_OPERATION_RECEIPT_LOCKED');
      }
      // An incompletely initialized lock is deliberately retained. Removing
      // it by pathname after an initialization error could delete a successor.
      throw error;
    }
    if (!acquired) {
      fail('Project operation receipt lock could not be acquired', 'PROJECT_OPERATION_RECEIPT_LOCKED');
    }

    try {
      const existing = this.read({ operationId, tenantId });
      if (existing) {
        if (existing.workspaceId !== workspaceId || existing.changeSetHash !== changeSetHash) {
          fail('Operation ID is already bound to a different tenant-scoped project change', 'PROJECT_OPERATION_RECEIPT_IDENTITY_CONFLICT');
        }
        return existing;
      }

      const receipt = {
        version: 1,
        operationId,
        tenantId,
        workspaceId,
        changeSetHash,
        recordedAt: new Date().toISOString(),
        result
      };
      const temporary = filePath + '.tmp.' + token;
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(receipt) + '\n', 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, filePath);
        syncDirectory(this.directory);
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch {}
        }
        try { fs.unlinkSync(temporary); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return receipt;
    } finally {
      // The unguessable per-acquisition marker path is the ownership
      // capability. A replacement lock has a different marker name, so this
      // cleanup can never unlink that successor's owner file.
      try {
        fs.unlinkSync(ownerPath);
        fs.rmdirSync(lockPath);
        syncDirectory(this.directory);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

ProjectOperationReceiptStore.digest = digest;
module.exports = ProjectOperationReceiptStore;
