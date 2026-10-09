const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeMemory } = require('../../domain/memory/memory.entity');

class JsonMemoryRepository {
  constructor(filePath, { lockTimeoutMs = 30000 } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }
    this.lockTimeoutMs = lockTimeoutMs;
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.ensureStorage();
    this.migrateLegacyData();
  }

  ensureStorage() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    // Publish a fully-written store atomically. Creating the final path with
    // "wx" and then writing it would expose an empty/partial file to peers.
    const temporaryFile = this.filePath + '.init.' + process.pid + '.' + crypto.randomUUID();
    let fd = null;
    try {
      fd = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(fd, '[]\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      try {
        // link(2) is atomic and no-clobber: EEXIST means another process won.
        fs.linkSync(temporaryFile, this.filePath);
      } catch (error) {
        if (error.code === 'EEXIST') return;
        throw error;
      }
    } catch (error) {
      throw new Error('Memory storage initialization failed: ' + error.message);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      try {
        fs.unlinkSync(temporaryFile);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error('Memory storage initialization cleanup failed: ' + error.message);
        }
      }
    }

    // Persist the directory entry where supported. Unexpected I/O errors are
    // surfaced rather than silently claiming durable initialization.
    try {
      const directoryFd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) {
        throw new Error('Memory storage directory sync failed: ' + error.message);
      }
    }
  }
  readRaw() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      throw new Error(`Memory storage read failed: ${error.message}`);
    }
  }

  normalize(memory) {
    const normalized = normalizeMemory(memory);
    if (!normalized.id) normalized.id = crypto.randomUUID();
    return normalized;
  }

  migrateLegacyData() {
    // Avoid lock overhead for the normal empty/new store. If legacy records
    // exist, re-read under the lock so migration cannot overwrite concurrent writes.
    if (!this.readRaw().length) return;

    return this.withLock(() => {
      const current = this.readRaw();
      if (!current.length) return;
      const migrated = current.map(memory => this.normalize(memory));
      const changed = migrated.some((memory, index) =>
        JSON.stringify(memory) !== JSON.stringify(current[index])
      );
      if (changed) this.write(migrated);
    });
  }
  read() {
    return this.readRaw().map(memory => this.normalize(memory));
  }

  withLock(operation) {
    const deadline = Date.now() + this.lockTimeoutMs;
    const hostname = require('os').hostname();

    const readOwner = lockPath => {
      try {
        const stat = fs.lstatSync(lockPath);
        const ownerPath = stat.isDirectory() ? path.join(lockPath, 'owner.json') : lockPath;
        return JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) || error instanceof SyntaxError) return null;
        throw error;
      }
    };

    const restoreQuarantine = quarantinePath => {
      try {
        // Restore only via a no-clobber link. Never fall back to rename, which
        // can replace a lock published by a different contender.
        fs.linkSync(quarantinePath, this.lockPath);
        fs.unlinkSync(quarantinePath);
      } catch (error) {
        if (error.code === 'EEXIST' || error.code === 'EPERM' ||
            error.code === 'EISDIR' || error.code === 'EMLINK' ||
            error.code === 'ENOENT') {
          // Preserve an unverified quarantined object rather than risk deleting
          // or overwriting another owner's active lock.
          return;
        }
        throw error;
      }
    };

    while (true) {
      const token = crypto.randomUUID();
      const owner = { token, pid: process.pid, hostname, acquiredAt: new Date().toISOString() };
      const candidatePath = `${this.lockPath}.candidate.${token}`;
      let acquired = false;

      // A fully-written regular file is published with link(2), which is
      // atomic and fails with EEXIST instead of replacing another owner's lock.
      try {
        const fd = fs.openSync(candidatePath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(owner) + '\n', 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        try {
          fs.linkSync(candidatePath, this.lockPath);
          acquired = true;
        } catch (publishError) {
          if (publishError.code !== 'EEXIST' && publishError.code !== 'EPERM' &&
              publishError.code !== 'EACCES' && publishError.code !== 'EISDIR') throw publishError;
          if (publishError.code !== 'EEXIST' && !fs.existsSync(this.lockPath)) throw publishError;
        }
      } finally {
        try { fs.unlinkSync(candidatePath); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }

      if (acquired) {
        try {
          return operation();
        } finally {
          const quarantinePath = `${this.lockPath}.release.${token}`;
          try {
            fs.renameSync(this.lockPath, quarantinePath);
            const releasedOwner = readOwner(quarantinePath);
            if (releasedOwner && releasedOwner.token === token) {
              fs.unlinkSync(quarantinePath);
            } else {
              restoreQuarantine(quarantinePath);
            }
          } catch (releaseError) {
            if (releaseError.code !== 'ENOENT') {
              // Do not mask the protected operation's exception with cleanup
              // trouble; preserve the quarantined lock for conservative recovery.
            }
          }
        }
      }

      const existingOwner = readOwner(this.lockPath);
      let stale = false;
      if (existingOwner && existingOwner.hostname === hostname &&
          Number.isInteger(existingOwner.pid) && existingOwner.pid > 0) {
        try {
          process.kill(existingOwner.pid, 0);
        } catch (processError) {
          stale = processError.code === 'ESRCH';
          if (processError.code !== 'ESRCH' && processError.code !== 'EPERM') throw processError;
        }
      }

      if (stale) {
        const quarantinePath = `${this.lockPath}.stale.${crypto.randomUUID()}`;
        try {
          fs.renameSync(this.lockPath, quarantinePath);
          const movedOwner = readOwner(quarantinePath);
          if (movedOwner && movedOwner.token === existingOwner.token &&
              movedOwner.pid === existingOwner.pid && movedOwner.hostname === existingOwner.hostname) {
            const stat = fs.lstatSync(quarantinePath);
            if (stat.isDirectory()) fs.rmSync(quarantinePath, { recursive: true, force: true });
            else fs.unlinkSync(quarantinePath);
          } else {
            restoreQuarantine(quarantinePath);
          }
          continue;
        } catch (reclaimError) {
          if (reclaimError.code !== 'ENOENT' && reclaimError.code !== 'EEXIST' &&
              reclaimError.code !== 'ENOTEMPTY') throw reclaimError;
        }
      }

      if (Date.now() >= deadline) {
        const lockError = new Error('Memory storage lock timeout');
        lockError.code = 'MEMORY_STORAGE_LOCK_TIMEOUT';
        throw lockError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }

  write(memories) {
    const temporaryFile = `${this.filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try {
      const fd = fs.openSync(temporaryFile, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(memories, null, 2) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporaryFile, this.filePath);
      try {
        const directoryFd = fs.openSync(path.dirname(this.filePath), 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
      }
    } catch (error) {
      try { if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile); } catch {}
      throw new Error(`Memory storage write failed: ${error.message}`);
    }
  }

  findAll(tenantId = 'local', scope = null) {
    if (tenantId && typeof tenantId === 'object') {
      scope = tenantId.scope || null;
      tenantId = tenantId.tenantId || 'local';
    }
    return this.read().filter(memory =>
      memory.tenantId === tenantId && (!scope || memory.scope === scope)
    );
  }

  findById(id, tenantId = 'local', scope = null) {
    return this.read().find(memory =>
      memory.id === id && memory.tenantId === tenantId &&
      (!scope || memory.scope === scope)
    ) || null;
  }

  findByFingerprint({ tenantId = 'local', scope = null, type, text }) {
    const normalizedText = String(text || '').trim().toLowerCase();
    return this.findAll(tenantId, scope).find(memory =>
      memory.state === 'active' && memory.type === type &&
      memory.text.trim().toLowerCase() === normalizedText
    ) || null;
  }

  findActiveBySemanticKey(semanticKey, tenantId = 'local', scope = null) {
    const key = String(semanticKey || '').trim();
    if (!key) return null;
    return this.findAll(tenantId, scope).find(memory =>
      memory.state === 'active' && memory.semanticKey === key
    ) || null;
  }

  insert(memory) {
    const normalized = this.normalize(memory);
    return this.withLock(() => {
      const memories = this.read();
      memories.unshift(normalized);
      this.write(memories);
      return normalized;
    });
  }

  update(id, patch, tenantId = 'local', scope = null) {
    if (!patch || typeof patch !== 'object') throw new TypeError('patch must be an object');
    if (patch.tenantId !== undefined && String(patch.tenantId) !== String(tenantId)) {
      throw Object.assign(new Error('Memory tenant is immutable'), { code: 'MEMORY_TENANT_IMMUTABLE' });
    }
    if (scope && patch.scope !== undefined && String(patch.scope) !== String(scope)) {
      throw Object.assign(new Error('Memory scope is immutable'), { code: 'MEMORY_SCOPE_IMMUTABLE' });
    }

    return this.withLock(() => {
      const memories = this.read();
      const index = memories.findIndex(memory =>
        memory.id === id && memory.tenantId === tenantId &&
        (!scope || memory.scope === scope)
      );
      if (index === -1) return null;

      const updated = this.normalize({
        ...memories[index],
        ...patch,
        id: memories[index].id,
        tenantId: memories[index].tenantId,
        ...(scope ? { scope: memories[index].scope } : {}),
        updatedAt: patch.updatedAt || new Date().toISOString()
      });

      memories[index] = updated;
      this.write(memories);
      return updated;
    });
  }

  deleteById(id, tenantId = 'local', scope = null) {
    return this.withLock(() => {
      const memories = this.read();
      const index = memories.findIndex(memory =>
        memory.id === id && memory.tenantId === tenantId &&
        (!scope || memory.scope === scope)
      );
      if (index === -1) return false;
      memories.splice(index, 1);
      this.write(memories);
      return true;
    });
  }
}

module.exports = JsonMemoryRepository;
