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

    // Serialize first-time initialization with an atomic directory lock. Unlike
    // hard links, mkdir is supported by Android app-private filesystems.
    const initLockPath = this.filePath + '.init-lock';
    const deadline = Date.now() + this.lockTimeoutMs;
    let ownsInitLock = false;
    while (!ownsInitLock) {
      try {
        fs.mkdirSync(initLockPath, { mode: 0o700 });
        ownsInitLock = true;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw new Error('Memory storage initialization lock failed: ' + error.message);
        }
        if (fs.existsSync(this.filePath)) return;
        if (Date.now() >= deadline) {
          const lockError = new Error('Memory storage initialization lock timeout');
          lockError.code = 'MEMORY_STORAGE_INIT_LOCK_TIMEOUT';
          throw lockError;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }

    const temporaryFile = this.filePath + '.init.' + process.pid + '.' + crypto.randomUUID();
    let fd = null;
    try {
      // Recheck after acquiring the lock: another constructor may have won.
      if (fs.existsSync(this.filePath)) return;

      fd = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(fd, '[]\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      try {
        // Prefer atomic no-clobber publication on filesystems that support it.
        fs.linkSync(temporaryFile, this.filePath);
      } catch (error) {
        if (error.code === 'EEXIST') return;
        if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOTSUP') {
          throw error;
        }
        // Every current-version initializer holds initLockPath, so rename is
        // atomic and cannot race another cooperating initializer. Do not use
        // this fallback for the mutable memory data or ownership lock files.
        if (fs.existsSync(this.filePath)) return;
        fs.renameSync(temporaryFile, this.filePath);
      }

      try {
        const directoryFd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) {
          throw new Error('Memory storage directory sync failed: ' + error.message);
        }
      }
    } catch (error) {
      throw new Error('Memory storage initialization failed: ' + error.message);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(temporaryFile); } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error('Memory storage initialization cleanup failed: ' + error.message);
        }
      }
      if (ownsInitLock) {
        try { fs.rmdirSync(initLockPath); } catch (error) {
          if (error.code !== 'ENOENT') {
            throw new Error('Memory storage initialization lock cleanup failed: ' + error.message);
          }
        }
      }
    }
  }
  readRaw() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) throw new Error('Memory storage file is empty');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('Memory storage root must be an array');
      }
      return parsed;
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
          if (publishError.code === 'EEXIST') {
            // Another contender owns the lock.
          } else if (['EPERM', 'EACCES', 'ENOTSUP'].includes(publishError.code)) {
            // Some Android/Termux filesystems reject hard links. Exclusive
            // creation still atomically claims the lock path; peers must treat
            // a temporarily incomplete owner record as occupied, never free.
            let lockFd = null;
            let lockFdStat = null;
            try {
              lockFd = fs.openSync(this.lockPath, 'wx', 0o600);
              lockFdStat = fs.fstatSync(lockFd);
              fs.writeFileSync(lockFd, JSON.stringify(owner) + '\n', 'utf8');
              fs.fsyncSync(lockFd);
              acquired = true;
            } catch (fallbackError) {
              if (fallbackError.code !== 'EEXIST') {
                if (lockFd !== null && lockFdStat) {
                  try {
                    const current = fs.lstatSync(this.lockPath);
                    if (current.dev === lockFdStat.dev && current.ino === lockFdStat.ino) {
                      fs.unlinkSync(this.lockPath);
                    }
                  } catch (cleanupError) {
                    if (!['ENOENT', 'EACCES', 'EPERM'].includes(cleanupError.code)) throw cleanupError;
                  }
                }
                if (!fs.existsSync(this.lockPath)) throw fallbackError;
              }
            } finally {
              if (lockFd !== null) fs.closeSync(lockFd);
            }
          } else {
            throw publishError;
          }
        }
      } finally {
        try { fs.unlinkSync(candidatePath); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }

      if (acquired) {
        let operationResult;
        let operationError;
        try {
          operationResult = operation();
        } catch (error) {
          operationError = error;
        }

        let releaseError = null;
        const quarantinePath = `${this.lockPath}.release.${token}`;
        try {
          fs.renameSync(this.lockPath, quarantinePath);
          const releasedOwner = readOwner(quarantinePath);
          if (releasedOwner && releasedOwner.token === token) {
            fs.unlinkSync(quarantinePath);
          } else {
            restoreQuarantine(quarantinePath);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') releaseError = error;
        }

        // The protected operation's error is authoritative. If it succeeded,
        // however, report a failed release instead of silently leaving a lock
        // that can block later operations in this still-live process.
        if (operationError) throw operationError;
        if (releaseError) {
          const error = new Error('Memory storage lock release failed: ' + releaseError.message);
          error.code = 'MEMORY_STORAGE_LOCK_RELEASE_FAILED';
          error.cause = releaseError;
          throw error;
        }
        return operationResult;
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
        // Reclaiming by rename is not ownership-safe: the lock path may be
        // replaced after readOwner() and before renameSync(). The rename could
        // therefore move a different, live owner's lock. Fail closed instead;
        // recovery must be an explicit operator action while contenders are stopped.
        const staleLockError = new Error(
          'Memory storage lock appears stale; explicit recovery is required'
        );
        staleLockError.code = 'MEMORY_STORAGE_STALE_LOCK';
        staleLockError.details = {
          pid: existingOwner.pid,
          hostname: existingOwner.hostname,
          token: existingOwner.token
        };
        throw staleLockError;
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
