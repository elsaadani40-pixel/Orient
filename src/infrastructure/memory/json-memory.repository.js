const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeMemory } = require('../../domain/memory/memory.entity');

class JsonMemoryRepository {
  constructor(filePath) {
    if (!filePath) throw new TypeError('filePath is required');
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
          throw Object.assign(new Error('Memory storage lock timeout'), { code: 'MEMORY_STORAGE_LOCK_TIMEOUT' });
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
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
