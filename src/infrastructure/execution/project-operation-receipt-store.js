'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

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
    let stats;
    try {
      stats = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail('Project operation intent is not a regular file', 'PROJECT_OPERATION_INTENT_CORRUPT');
    }

    let intent;
    let fd;
    try {
      // Read through one file descriptor and compare the opened inode with the
      // inspected path. O_NOFOLLOW prevents a symlink swap where supported.
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_NOFOLLOW
        : 0;
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const openedStats = fs.fstatSync(fd);
      if (!openedStats.isFile() || openedStats.dev !== stats.dev || openedStats.ino !== stats.ino) {
        fail('Project operation intent changed while being opened', 'PROJECT_OPERATION_INTENT_CORRUPT');
      }
      intent = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (error) {
      const invalid = new Error('Project operation intent is not valid or changed while being read');
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
    let createdFile = false;
    try {
      fd = fs.openSync(filePath, 'wx', 0o600);
      createdFile = true;
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
        if (createdFile) {
          try { fs.unlinkSync(filePath); } catch {}
        }
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

  clearIntent({ operationId, tenantId, workspaceId, changeSetHash }) {
    const existing = this.readIntent({ operationId, tenantId });
    if (!existing) return false;
    if (existing.workspaceId !== workspaceId || existing.changeSetHash !== changeSetHash) {
      fail('Project operation intent identity changed before cleanup', 'PROJECT_OPERATION_INTENT_IDENTITY_CONFLICT');
    }
    fs.unlinkSync(this.intentPath(operationId, tenantId));
    syncDirectory(this.directory);
    return true;
  }

  read({ operationId, tenantId }) {
    const filePath = this.receiptPath(operationId, tenantId);
    let fileStats;
    try {
      fileStats = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      fail('Project operation receipt is not a regular file', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
    }

    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
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
    let lockFd;
    let acquired = false;

    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      try {
        lockFd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(lockFd, JSON.stringify({
          token,
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString()
        }) + '\n', 'utf8');
        fs.fsyncSync(lockFd);
        fs.closeSync(lockFd);
        lockFd = undefined;
        syncDirectory(this.directory);
        acquired = true;
      } catch (error) {
        if (lockFd !== undefined) {
          try { fs.closeSync(lockFd); } catch {}
          lockFd = undefined;
        }
        if (error.code !== 'EEXIST') throw error;

        let current;
        try { current = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
        let staleLocalOwner = false;
        if (current?.hostname === os.hostname() &&
            Number.isInteger(current.pid) && current.pid > 0) {
          try {
            process.kill(current.pid, 0);
          } catch (probeError) {
            if (probeError.code === 'ESRCH') staleLocalOwner = true;
            else if (probeError.code !== 'EPERM') throw probeError;
          }
        }
        if (!staleLocalOwner || attempt > 0) {
          fail('Project operation receipt is locked; refusing concurrent write', 'PROJECT_OPERATION_RECEIPT_LOCKED');
        }
        const quarantine = lockPath + '.stale.' + crypto.randomUUID();
        try {
          fs.renameSync(lockPath, quarantine);
          try { fs.unlinkSync(quarantine); } catch {}
          syncDirectory(this.directory);
        } catch (renameError) {
          if (renameError.code !== 'ENOENT') throw renameError;
        }
      }
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
      let current;
      try { current = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
      if (current?.token === token) {
        fs.unlinkSync(lockPath);
        syncDirectory(this.directory);
      }
    }
  }
}

ProjectOperationReceiptStore.digest = digest;
module.exports = ProjectOperationReceiptStore;
