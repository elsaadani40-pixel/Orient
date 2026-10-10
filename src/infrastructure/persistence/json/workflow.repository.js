const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class WorkflowRepository {
  ensureStorage() {
    return this.withLock(() => {
      if (fs.existsSync(this.filePath)) return;

      const temp = this.filePath + '.init.' + process.pid + '.' + crypto.randomUUID();
      let fd = null;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, '[]\n', 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(temp, this.filePath);

        const directoryFd = fs.openSync(path.dirname(this.filePath), 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } finally {
        if (fd !== null) fs.closeSync(fd);
        try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      }
    });
  }
  constructor(filePath, { lockTimeoutMs = 30000 } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }
    this.lockTimeoutMs = lockTimeoutMs;
    this.filePath = path.resolve(filePath);
    this.lockPath = this.filePath + '.lock';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.ensureStorage();
  }

  read() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : [];
  }

  withLock(operation) {
    const timeoutMs = this.lockTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const hostname = require('os').hostname();

    while (true) {
      const token = crypto.randomUUID();
      let acquiredDirectory = false;
      try {
        fs.mkdirSync(this.lockPath);
        acquiredDirectory = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      if (acquiredDirectory) {
        const ownerPath = path.join(this.lockPath, 'owner.json');
        const owner = { token, pid: process.pid, hostname, acquiredAt: new Date().toISOString() };
        try {
          fs.writeFileSync(ownerPath, JSON.stringify(owner) + '\n', {
            encoding: 'utf8', flag: 'wx', mode: 0o600
          });
        } catch (error) {
          try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {}
          throw error;
        }

        try {
          return operation();
        } finally {
          try {
            const currentOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
            if (currentOwner.token === token) {
              fs.rmSync(this.lockPath, { recursive: true, force: true });
            }
          } catch {}
        }
      }

      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(this.lockPath, 'owner.json'), 'utf8'));
      } catch (ownerError) {
        if (ownerError.code !== 'ENOENT' && !(ownerError instanceof SyntaxError)) throw ownerError;
      }

      let stale = false;
      if (owner && owner.hostname === hostname && Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (processError) {
          stale = processError.code === 'ESRCH';
          if (processError.code !== 'ESRCH' && processError.code !== 'EPERM') throw processError;
        }
      }

      if (stale) {
        const quarantinePath = this.lockPath + '.stale.' + crypto.randomUUID();
        try {
          fs.renameSync(this.lockPath, quarantinePath);
          let movedOwner = null;
          try { movedOwner = JSON.parse(fs.readFileSync(path.join(quarantinePath, 'owner.json'), 'utf8')); } catch {}
          if (movedOwner && movedOwner.token === owner.token &&
              movedOwner.pid === owner.pid && movedOwner.hostname === owner.hostname) {
            fs.rmSync(quarantinePath, { recursive: true, force: true });
          } else {
            try { fs.renameSync(quarantinePath, this.lockPath); } catch {}
          }
          continue;
        } catch (reclaimError) {
          if (reclaimError.code !== 'ENOENT' && reclaimError.code !== 'EEXIST') throw reclaimError;
        }
      }

      if (Date.now() >= deadline) {
        const lockError = new Error('Workflow storage lock timeout');
        lockError.code = 'WORKFLOW_STORAGE_LOCK_TIMEOUT';
        throw lockError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }

  write(items) {
    const temp = this.filePath + '.tmp.' + process.pid + '.' + crypto.randomUUID();
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(items, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(temp, this.filePath);
      const directoryFd = fs.openSync(path.dirname(this.filePath), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (error) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
    }
  }

  save(instance, tenantId = null) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenantId = item.tenantId || 'local';
    if (tenantId && effectiveTenantId !== tenantId) throw new Error('Workflow tenant mismatch');

    return this.withLock(() => {
      const items = this.read();
      const existing = items.find(candidate => candidate.workflowId === item.workflowId) || null;
      if (existing && (existing.tenantId || 'local') !== effectiveTenantId) {
        throw new Error('Workflow tenant collision');
      }

      const currentRevision = Number(existing?.checkpoint?.revision || 0);
      const expectedRevision = Number(item.checkpoint?.revision || 0);
      if (existing && expectedRevision !== currentRevision) {
        const error = new Error('Stale workflow checkpoint');
        error.code = 'WORKFLOW_CHECKPOINT_CONFLICT';
        error.status = 409;
        throw error;
      }

      const nextRevision = existing ? currentRevision + 1 : Math.max(1, expectedRevision);
      item.checkpoint = {
        revision: nextRevision,
        lastSavedAt: new Date().toISOString()
      };

      const next = items.filter(candidate => candidate.workflowId !== item.workflowId);
      next.push(item);
      this.write(next);

      if (typeof instance?.setCheckpointRevision === 'function') {
        instance.setCheckpointRevision(nextRevision, item.checkpoint.lastSavedAt);
      }
      return item;
    });
  }

  repair(instance, { tenantId = null, expectedRevision = 0, targetRevision } = {}) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenantId = item.tenantId || 'local';
    if (tenantId && effectiveTenantId !== tenantId) throw new Error('Workflow tenant mismatch');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !Number.isInteger(targetRevision) || targetRevision <= expectedRevision) {
      const error = new Error('Invalid workflow repair revision');
      error.code = 'WORKFLOW_REPAIR_REVISION_INVALID'; error.status = 409; throw error;
    }
    return this.withLock(() => {
      const items = this.read();
      const existing = items.find(candidate => candidate.workflowId === item.workflowId) || null;
      const currentRevision = Number(existing?.checkpoint?.revision || 0);
      if (existing && (existing.tenantId || 'local') !== effectiveTenantId) throw new Error('Workflow tenant collision');
      if (currentRevision !== expectedRevision) {
        const error = new Error('Stale workflow checkpoint during repair');
        error.code = 'WORKFLOW_CHECKPOINT_CONFLICT'; error.status = 409; throw error;
      }
      item.checkpoint = { revision: targetRevision, lastSavedAt: new Date().toISOString() };
      const next = items.filter(candidate => candidate.workflowId !== item.workflowId); next.push(item); this.write(next);
      if (typeof instance?.setCheckpointRevision === 'function') instance.setCheckpointRevision(targetRevision, item.checkpoint.lastSavedAt);
      return item;
    });
  }

  requestCancellation(workflowId, tenantId = null) {
    return this.withLock(() => {
      const items = this.read();
      const index = items.findIndex(item => item.workflowId === workflowId && (!tenantId || (item.tenantId || 'local') === tenantId));
      if (index < 0) return false;
      const item = { ...items[index], cancelRequested: true, updatedAt: new Date().toISOString() };
      if (['CREATED', 'QUEUED', 'WAITING', 'RECOVERING'].includes(item.state)) item.state = 'CANCELLED';
      const next = [...items]; next[index] = item; this.write(next); return item;
    });
  }

  findById(workflowId, tenantId = null) {
    return this.read().find(
      item => item.workflowId === workflowId && (!tenantId || item.tenantId === tenantId)
    ) || null;
  }

  findByApprovalExecutionId({ executionId, tenantId = null } = {}) {
    if (!executionId) return null;
    return this.read().find(item =>
      (!tenantId || item.tenantId === tenantId) &&
      item.metadata?.approvalBlocked === true &&
      String(item.metadata.approvalExecutionId || '') === String(executionId)
    ) || null;
  }

  findAll({ tenantId = null } = {}) {
    return this.read().filter(item => !tenantId || item.tenantId === tenantId);
  }

  delete(workflowId, tenantId = null) {
    return this.withLock(() => {
      const items = this.read();
      const next = items.filter(
        item => !(item.workflowId === workflowId && (!tenantId || item.tenantId === tenantId))
      );
      if (next.length !== items.length) this.write(next);
      return next.length !== items.length;
    });
  }
}

module.exports = WorkflowRepository;
