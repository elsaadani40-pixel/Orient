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
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '[]\n', 'utf8');
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
    const current = this.readRaw();
    if (!current.length) return;
    const migrated = current.map(memory => this.normalize(memory));
    const changed = migrated.some((memory, index) =>
      JSON.stringify(memory) !== JSON.stringify(current[index])
    );
    if (changed) this.write(migrated);
  }

  read() {
    return this.readRaw().map(memory => this.normalize(memory));
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
