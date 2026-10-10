const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ApprovalRepository {
  constructor(filePath, { lockTimeoutMs = 30000 } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }
    this.lockTimeoutMs = lockTimeoutMs;
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
    if (!raw.trim()) throw new Error('Approval storage file is empty');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Approval storage root must be an object');
    }
    return parsed;
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
        const lockError = new Error('Approval storage lock timeout');
        lockError.code = 'APPROVAL_STORAGE_LOCK_TIMEOUT';
        throw lockError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
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

  async findPending({ tenantId = null, limit = 100, now = Date.now() } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    return Object.values(this.read())
      .filter(record => record && !record.used)
      .filter(record => !tenantId || record.tenantId === tenantId || record.metadata?.tenantId === tenantId)
      .filter(record => !record.expiresAt || now < Date.parse(record.expiresAt))
      .sort((a, b) => Date.parse(a.issuedAt || 0) - Date.parse(b.issuedAt || 0))
      .slice(0, boundedLimit)
      .map(record => JSON.parse(JSON.stringify(record)));
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


  async recordDecision(approvalId, decision, tenantId = null, now = () => Date.now()) {
    if (!approvalId) throw new TypeError('approvalId is required');
    if (!decision || !['approved', 'rejected'].includes(decision.status) ||
        typeof decision.actorId !== 'string' || !decision.actorId.trim() ||
        typeof decision.decidedAt !== 'string') {
      throw Object.assign(new TypeError('Invalid approval decision record'), { code: 'APPROVAL_DECISION_INVALID' });
    }

    return this.withLock(() => {
      const records = this.read();
      const record = records[approvalId];
      if (!record) throw Object.assign(new Error('Approval not found'), { code: 'APPROVAL_NOT_FOUND' });
      if (tenantId && record.tenantId !== tenantId && record.metadata?.tenantId !== tenantId) {
        throw Object.assign(new Error('Approval tenant mismatch'), { code: 'APPROVAL_TENANT_MISMATCH' });
      }
      // An exact replay of the immutable decision remains idempotent even
      // after the approved operation consumed the challenge or its TTL elapsed.
      if (record.decision) {
        if (record.decision.status === decision.status && record.decision.actorId === decision.actorId) {
          return JSON.parse(JSON.stringify(record));
        }
        throw Object.assign(new Error('Approval already has a different decision'), { code: 'APPROVAL_DECISION_CONFLICT' });
      }
      if (record.used) throw Object.assign(new Error('Approval already consumed'), { code: 'APPROVAL_ALREADY_USED' });
      const expiresAt = typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : NaN;
      const decisionNow = typeof now === 'function' ? now() : now;
      if (!Number.isFinite(expiresAt) || !Number.isFinite(decisionNow) || decisionNow >= expiresAt) {
        throw Object.assign(new Error('Approval expired or has an invalid expiry timestamp'), { code: 'APPROVAL_EXPIRED' });
      }
      records[approvalId] = { ...record, decision: { ...decision } };
      this.write(records);
      return JSON.parse(JSON.stringify(records[approvalId]));
    });
  }

  async consume(approvalId, usedAt, tenantId = null, now = () => Date.now()) {
    if (!approvalId) return false;

    return this.withLock(() => {
      const records = this.read();
      const record = records[approvalId];
      if (!record) return false;
      if (tenantId && record.tenantId !== tenantId && record.metadata?.tenantId !== tenantId) return false;
      if (record.used || record.decision?.status !== 'approved') return false;
      const requestedAt = typeof usedAt === 'string' ? Date.parse(usedAt) : NaN;
      const consumedAt = typeof now === 'function' ? now() : now;
      const expiresAt = typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : NaN;
      if (!Number.isFinite(requestedAt) || !Number.isFinite(consumedAt) ||
          !Number.isFinite(expiresAt) || requestedAt >= expiresAt || consumedAt >= expiresAt) return false;

      records[approvalId] = {
        ...record,
        used: true,
        usedAt: new Date(consumedAt).toISOString()
      };
      this.write(records);
      return true;
    });
  }
}

module.exports = ApprovalRepository;
