const fs = require('fs');
const path = require('path');

class ApprovalRepository {
  constructor(filePath) {
    if (!filePath) throw new TypeError('filePath is required');
    this.filePath = filePath;
    this.lockPath = filePath + '.lock';
    this.ensureStorage();
  }

  ensureStorage() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '{}\n', 'utf8');
  }

  read() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Approval storage root must be an object');
    }
    return parsed;
  }

  withLock(operation) {
    const timeoutMs = 30000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        try { return operation(); }
        finally { try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {} }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;

        let stale = false;
        try {
          stale = Date.now() - fs.statSync(this.lockPath).mtimeMs > timeoutMs;
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
        }

        if (stale) {
          try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {}
          continue;
        }

        if (Date.now() >= deadline) {
          const lockError = new Error('Approval storage lock timeout');
          lockError.code = 'APPROVAL_STORAGE_LOCK_TIMEOUT';
          throw lockError;
        }

        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }

  write(records) {
    const temporaryFile = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      const fd = fs.openSync(
        temporaryFile,
        fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY,
        0o600
      );
      try {
        fs.writeFileSync(fd, JSON.stringify(records, null, 2) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      fs.renameSync(temporaryFile, this.filePath);

      try {
        const directoryFd = fs.openSync(path.dirname(this.filePath), 'r');
        try { fs.fsyncSync(directoryFd); }
        finally { fs.closeSync(directoryFd); }
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
      }
    } catch (error) {
      try { if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile); } catch {}
      throw new Error('Approval storage write failed: ' + error.message);
    }
  }

  async save(approval, { tenantId = null } = {}) {
    if (!approval?.approvalId) throw new TypeError('approval.approvalId is required');
    if (tenantId && approval.tenantId !== tenantId && approval.metadata?.tenantId !== tenantId) {
      throw Object.assign(new Error('Approval tenant mismatch'), { code: 'APPROVAL_TENANT_MISMATCH' });
    }

    return this.withLock(() => {
      const records = this.read();
      const existing = records[approval.approvalId];
      if (existing && tenantId && existing.tenantId !== tenantId && existing.metadata?.tenantId !== tenantId) {
        throw Object.assign(new Error('Approval tenant collision'), { code: 'APPROVAL_TENANT_MISMATCH' });
      }
      records[approval.approvalId] = JSON.parse(JSON.stringify(approval));
      this.write(records);
      return JSON.parse(JSON.stringify(records[approval.approvalId]));
    });
  }

  async findByExecution({ executionId, step = null, tool = null, planRevision = null, tenantId = null } = {}) {
    if (!executionId) return [];
    return Object.values(this.read())
      .filter(record => record && record.executionId === String(executionId))
      .filter(record => tenantId ? (record.tenantId === tenantId || record.metadata?.tenantId === tenantId) : true)
      .filter(record => step === null || Number(record.step) === Number(step))
      .filter(record => tool === null || record.tool === tool)
      .filter(record => planRevision === null || Number(record.planRevision || 1) === Number(planRevision))
      .sort((a, b) => Date.parse(b.issuedAt || 0) - Date.parse(a.issuedAt || 0))
      .map(record => JSON.parse(JSON.stringify(record)));
  }

  async findById(approvalId, { tenantId = null } = {}) {
    if (!approvalId) return null;
    const record = this.read()[approvalId] || null;
    if (!record) return null;
    if (tenantId && record.tenantId !== tenantId && record.metadata?.tenantId !== tenantId) return null;
    return JSON.parse(JSON.stringify(record));
  }

  async consume(approvalId, usedAt, tenantId = null) {
    if (!approvalId) return false;

    return this.withLock(() => {
      const records = this.read();
      const record = records[approvalId];
      if (!record) return false;
      if (tenantId && record.tenantId !== tenantId && record.metadata?.tenantId !== tenantId) return false;
      if (record.used) return false;

      records[approvalId] = {
        ...record,
        used: true,
        usedAt
      };
      this.write(records);
      return true;
    });
  }
}

module.exports = ApprovalRepository;
