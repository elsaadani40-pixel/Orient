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
  constructor(filePath) {
    if (!filePath) throw new TypeError('filePath is required');
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
    const deadline = Date.now() + 30000;
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        try { return operation(); }
        finally { try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {} }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - fs.statSync(this.lockPath).mtimeMs > 30000) {
          try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {}
          continue;
        }
        if (Date.now() >= deadline) throw Object.assign(new Error('Workflow storage lock timeout'), { code: 'WORKFLOW_STORAGE_LOCK_TIMEOUT' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
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
    const existing = this.findById(item.workflowId);
    if (existing && (existing.tenantId || 'local') !== effectiveTenantId) throw new Error('Workflow tenant collision');
    return this.withLock(() => {
      const items = this.read().filter(existing => existing.workflowId !== item.workflowId);
      items.push(item);
      this.write(items);
      return item;
    });
  }

  findById(workflowId, tenantId = null) {
    return this.read().find(
      item => item.workflowId === workflowId && (!tenantId || item.tenantId === tenantId)
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
