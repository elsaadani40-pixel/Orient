const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class WorkflowLeaseRepository {
  constructor(filePath, { lockTimeoutMs = 30000 } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }
    this.lockTimeoutMs = lockTimeoutMs;
    this.filePath = path.resolve(filePath);
    this.lockPath = this.filePath + '.lock';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      try {
        const fd = fs.openSync(this.filePath, 'wx', 0o600);
        try { fs.writeFileSync(fd, '[]\n', 'utf8'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
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
      try {
        fs.mkdirSync(this.lockPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      if (fs.existsSync(this.lockPath)) {
        // Only execute under a lock whose ownership metadata we created.
        let acquiredByThisCall = false;
        try {
          const ownerPath = path.join(this.lockPath, 'owner.json');
          const owner = {
            token,
            pid: process.pid,
            hostname,
            acquiredAt: new Date().toISOString()
          };
          fs.writeFileSync(ownerPath, JSON.stringify(owner) + '\n', {
            encoding: 'utf8', flag: 'wx', mode: 0o600
          });
          acquiredByThisCall = true;
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
        } catch (error) {
          if (acquiredByThisCall || error.code !== 'EEXIST') throw error;
          // owner.json already exists: another process owns this lock.
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
          try {
            movedOwner = JSON.parse(fs.readFileSync(path.join(quarantinePath, 'owner.json'), 'utf8'));
          } catch {}
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
        throw Object.assign(new Error('Workflow lease lock timeout'), { code: 'WORKFLOW_LEASE_LOCK_TIMEOUT' });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }

  write(items) {
    const temp = `${this.filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try {
      const fd = fs.openSync(temp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(items, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.filePath);
      try {
        const directoryFd = fs.openSync(path.dirname(this.filePath), 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
      }
    } catch (error) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      throw new Error('Workflow lease storage write failed: ' + error.message);
    }
  }

  save(lease, tenantId = null) {
    if (tenantId && lease.metadata?.tenantId !== tenantId) throw new Error('Lease tenant mismatch');
    return this.withLock(() => {
      const items = this.read();
      const existing = items.find(item => item.workflowId === lease.workflowId);
      if (existing && tenantId && existing.metadata?.tenantId !== tenantId) throw new Error('Lease tenant collision');
      const next = items.filter(item => item.workflowId !== lease.workflowId);
      next.push({ ...lease });
      this.write(next);
      return { ...lease };
    });
  }

  tryAcquire(lease, tenantId = null) {
    if (!lease?.workflowId) throw new TypeError('lease.workflowId is required');
    if (tenantId && lease.metadata?.tenantId !== tenantId) throw new Error('Lease tenant mismatch');

    return this.withLock(() => {
      const items = this.read();
      const now = Number(lease.acquiredAt);
      const current = items.find(item => item.workflowId === lease.workflowId);

      if (current && tenantId && current.metadata?.tenantId !== tenantId) throw new Error('Lease tenant collision');
      if (current && Number(current.expiresAt) > now) return false;

      const fencingToken = Number(current?.fencingToken || 0) + 1;
      const stored = { ...lease, fencingToken };
      const next = items.filter(item => item.workflowId !== lease.workflowId);
      next.push(stored);
      this.write(next);
      return { ...stored };
    });
  }

  assertCurrent(workflowId, leaseId, fencingToken, now = Date.now(), tenantId = null) {
    return this.withLock(() => {
      const current = this.read().find(item => item.workflowId === workflowId);
      if (!current || current.leaseId !== leaseId) return false;
      if (tenantId && current.metadata?.tenantId !== tenantId) return false;
      if (Number(current.expiresAt) <= now) return false;
      return Number(current.fencingToken) === Number(fencingToken);
    });
  }

  renewIfOwned(workflowId, leaseId, expiresAt, now = Date.now(), tenantId = null) {
    return this.withLock(() => {
      const items = this.read();
      const index = items.findIndex(item => item.workflowId === workflowId && item.leaseId === leaseId);
      if (index === -1) return false;
      const current = items[index];
      if (tenantId && current.metadata?.tenantId !== tenantId) return false;
      if (Number(current.expiresAt) <= now) return false;

      items[index] = { ...current, expiresAt };
      this.write(items);
      return true;
    });
  }

  findByWorkflowId(workflowId, tenantId = null) {
    return this.read().find(item => item.workflowId === workflowId &&
      (!tenantId || item.metadata?.tenantId === tenantId)) || null;
  }

  findAll({ tenantId = null } = {}) {
    return this.read().filter(item => !tenantId || item.metadata?.tenantId === tenantId);
  }

  delete(workflowId, leaseId, tenantId = null) {
    return this.withLock(() => {
      const items = this.read();
      const current = items.find(item => item.workflowId === workflowId && item.leaseId === leaseId);
      if (tenantId && current?.metadata?.tenantId !== tenantId) return false;
      const next = items.filter(item => !(item.workflowId === workflowId && item.leaseId === leaseId));
      if (next.length !== items.length) this.write(next);
      return next.length !== items.length;
    });
  }

  deleteExpired(workflowId, leaseId, now = Date.now(), tenantId = null) {
    return this.withLock(() => {
      const items = this.read();
      const current = items.find(item => item.workflowId === workflowId && item.leaseId === leaseId);
      if (!current || (tenantId && current.metadata?.tenantId !== tenantId) || Number(current.expiresAt) > now) return false;
      const next = items.filter(item => !(item.workflowId === workflowId && item.leaseId === leaseId));
      this.write(next);
      return true;
    });
  }
}

module.exports = WorkflowLeaseRepository;
