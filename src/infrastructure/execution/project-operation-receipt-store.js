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
 * A stale lock intentionally blocks writes instead of risking concurrent overwrite.
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
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      fail('Operation receipt directory is not a real directory', 'PROJECT_OPERATION_RECEIPT_DIRECTORY_INVALID');
    }
  }

  read({ operationId, tenantId }) {
    const filePath = this.receiptPath(operationId, tenantId);
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

    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(lockFd, JSON.stringify({ token, pid: process.pid }) + '\n', 'utf8');
      fs.fsyncSync(lockFd);
    } catch (error) {
      if (error.code === 'EEXIST') {
        fail('Project operation receipt is locked; refusing concurrent write', 'PROJECT_OPERATION_RECEIPT_LOCKED');
      }
      throw error;
    } finally {
      if (lockFd !== undefined) fs.closeSync(lockFd);
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
