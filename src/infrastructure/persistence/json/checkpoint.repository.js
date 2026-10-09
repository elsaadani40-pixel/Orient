const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CheckpointRepository {
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
      throw new Error('Checkpoint storage root must be an object');
    }
    return parsed;
  }

  write(records) {
    const temporaryFile = this.filePath + '.tmp.' + process.pid;
    const directory = path.dirname(this.filePath);
    try {
      const fd = fs.openSync(temporaryFile, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(records, null, 2) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporaryFile, this.filePath);
      const directoryFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (error) {
      try { if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile); } catch {}
      throw new Error('Checkpoint storage write failed: ' + error.message);
    }
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
        try { stale = Date.now() - fs.statSync(this.lockPath).mtimeMs > timeoutMs; }
        catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        if (stale) { try { fs.rmSync(this.lockPath, { recursive: true, force: true }); } catch {} continue; }
        if (Date.now() >= deadline) {
          const lockError = new Error('Checkpoint storage lock timeout');
          lockError.code = 'CHECKPOINT_STORAGE_LOCK_TIMEOUT';
          throw lockError;
        }
        const wait = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(wait), 0, 0, 5);
      }
    }
  }

  digest(snapshot) {
    return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  }

  save(snapshot, { reason = 'step_completed', tenantId = null } = {}) {
    if (!snapshot || typeof snapshot !== 'object') throw new TypeError('snapshot must be an object');
    if (!snapshot.executionId) throw new TypeError('snapshot.executionId is required');
    if (tenantId && snapshot.tenantId !== tenantId && snapshot.metadata?.tenantId !== tenantId) {
      throw Object.assign(new Error('Checkpoint tenant mismatch'), { code: 'TENANT_CONTEXT_MISMATCH' });
    }

    return this.withLock(() => {
      const records = this.read();
      const previous = records[snapshot.executionId];
      if (previous && tenantId) {
        const previousTenantId = previous.snapshot?.tenantId || previous.snapshot?.metadata?.tenantId || (tenantId === 'local' ? 'local' : null);
        if (previousTenantId !== tenantId) throw Object.assign(new Error('Checkpoint tenant collision'), { code: 'TENANT_CONTEXT_MISMATCH' });
      }
      const sequence = Number(previous?.sequence || 0) + 1;
      const storedSnapshot = JSON.parse(JSON.stringify(snapshot));
      const checkpoint = {
        checkpointId: crypto.randomUUID(),
        executionId: snapshot.executionId,
        sequence,
        reason,
        createdAt: new Date().toISOString(),
        snapshot: storedSnapshot,
        snapshotSha256: this.digest(storedSnapshot),
        ...(previous?.resumeLease ? { resumeLease: previous.resumeLease } : {})
      };
      records[snapshot.executionId] = checkpoint;
      this.write(records);
      return JSON.parse(JSON.stringify(checkpoint));
    });
  }

  acquireResumeLease(executionId, { tenantId = null, leaseDurationMs = 30000 } = {}) {
    if (!executionId) throw new TypeError('executionId is required');
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new TypeError('leaseDurationMs must be a positive integer');
    }

    return this.withLock(() => {
      const records = this.read();
      const checkpoint = records[executionId];
      if (!checkpoint) return null;

      const snapshot = checkpoint.snapshot || {};
      const snapshotTenantId = snapshot.tenantId || snapshot.metadata?.tenantId || (tenantId === 'local' ? 'local' : null);
      if (tenantId && snapshotTenantId !== tenantId) return null;

      const now = Date.now();
      const existing = checkpoint.resumeLease || null;
      if (existing && Number(existing.expiresAtMs) > now) {
        const error = new Error('Execution resume lease is already held');
        error.code = 'CHECKPOINT_RESUME_LEASE_HELD';
        throw error;
      }

      const lease = {
        leaseId: crypto.randomUUID(),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + leaseDurationMs).toISOString(),
        expiresAtMs: now + leaseDurationMs
      };

      records[executionId] = {
        ...checkpoint,
        resumeLease: lease
      };
      this.write(records);

      return JSON.parse(JSON.stringify(lease));
    });
  }

  renewResumeLease(executionId, leaseId, { tenantId = null, leaseDurationMs = 30000 } = {}) {
    if (!executionId || !leaseId) return null;
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new TypeError('leaseDurationMs must be a positive integer');
    }

    return this.withLock(() => {
      const records = this.read();
      const checkpoint = records[executionId];
      if (!checkpoint) return null;

      const snapshot = checkpoint.snapshot || {};
      const snapshotTenantId = snapshot.tenantId || snapshot.metadata?.tenantId || (tenantId === 'local' ? 'local' : null);
      if (tenantId && snapshotTenantId !== tenantId) return null;

      const existing = checkpoint.resumeLease;
      const now = Date.now();
      if (!existing || existing.leaseId !== leaseId || Number(existing.expiresAtMs) <= now) return null;

      const lease = {
        ...existing,
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + leaseDurationMs).toISOString(),
        expiresAtMs: now + leaseDurationMs
      };
      records[executionId] = { ...checkpoint, resumeLease: lease };
      this.write(records);
      return JSON.parse(JSON.stringify(lease));
    });
  }

  releaseResumeLease(executionId, leaseId, { tenantId = null } = {}) {
    if (!executionId || !leaseId) return false;

    return this.withLock(() => {
      const records = this.read();
      const checkpoint = records[executionId];
      if (!checkpoint) return false;

      const snapshot = checkpoint.snapshot || {};
      const snapshotTenantId = snapshot.tenantId || snapshot.metadata?.tenantId || (tenantId === 'local' ? 'local' : null);
      if (tenantId && snapshotTenantId !== tenantId) return false;
      if (checkpoint.resumeLease?.leaseId !== leaseId) return false;

      const { resumeLease, ...withoutLease } = checkpoint;
      records[executionId] = withoutLease;
      this.write(records);
      return true;
    });
  }

  findLatest(executionId, { verify = true, tenantId = null } = {}) {
    if (!executionId) return null;
    const checkpoint = this.read()[executionId] || null;
    if (!checkpoint) return null;
    if (tenantId && checkpoint.snapshot?.tenantId && checkpoint.snapshot.tenantId !== tenantId) return null;
    if (tenantId && !checkpoint.snapshot?.tenantId && checkpoint.snapshot?.metadata?.tenantId && checkpoint.snapshot.metadata.tenantId !== tenantId) return null;
    if (tenantId && !checkpoint.snapshot?.tenantId && !checkpoint.snapshot?.metadata?.tenantId && tenantId !== 'local') return null;
    if (verify && checkpoint.snapshotSha256 !== this.digest(checkpoint.snapshot)) {
      const error = new Error('Checkpoint integrity verification failed: ' + executionId);
      error.code = 'CHECKPOINT_INTEGRITY_FAILED';
      throw error;
    }
    return JSON.parse(JSON.stringify(checkpoint));
  }

  delete(executionId, { tenantId = null } = {}) {
    return this.withLock(() => {
      const records = this.read();
      if (!records[executionId]) return false;
      if (tenantId && records[executionId].snapshot?.tenantId !== tenantId && records[executionId].snapshot?.metadata?.tenantId !== tenantId) return false;
      delete records[executionId];
      this.write(records);
      return true;
    });
  }

  clear() {
    return this.withLock(() => this.write({}));
  }

  count() {
    return Object.keys(this.read()).length;
  }
}

module.exports = CheckpointRepository;
