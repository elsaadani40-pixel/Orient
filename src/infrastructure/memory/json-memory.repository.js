const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class JsonMemoryRepository {
  constructor(filePath) {
    this.filePath = filePath;
    this.ensureStorage();
    this.migrateLegacyData();
  }

  ensureStorage() {
    const directory = path.dirname(this.filePath);

    fs.mkdirSync(directory, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]\n', 'utf8');
    }
  }

  readRaw() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');

      if (!raw.trim()) {
        return [];
      }

      const parsed = JSON.parse(raw);

      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      throw new Error(`Memory storage read failed: ${error.message}`);
    }
  }

  normalize(memory, tenantId = null) {
    const now = new Date().toISOString();

    return {
      id: memory.id || crypto.randomUUID(),
      text: String(memory.text || '').trim(),
      createdAt: memory.createdAt || now,
      updatedAt: memory.updatedAt || memory.createdAt || now,
      tenantId: memory.tenantId || tenantId || 'local'
    };
  }

  migrateLegacyData() {
    const current = this.readRaw();

    if (!current.length) {
      return;
    }

    const migrated = current.map(memory => this.normalize(memory, 'local'));

    const changed = migrated.some((memory, index) => {
      const original = current[index];

      return (
        !original.id ||
        !original.createdAt ||
        !original.updatedAt
      );
    });

    if (changed) {
      this.write(migrated);
    }
  }

  read(tenantId = 'local') {
    return this.readRaw()
      .map(memory => this.normalize(memory, 'local'))
      .filter(memory => memory.tenantId === tenantId);
  }

  write(memories) {
    const temporaryFile = `${this.filePath}.tmp`;

    try {
      fs.writeFileSync(
        temporaryFile,
        JSON.stringify(memories, null, 2) + '\n',
        'utf8'
      );

      fs.renameSync(temporaryFile, this.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(temporaryFile)) {
          fs.unlinkSync(temporaryFile);
        }
      } catch {}

      throw new Error(`Memory storage write failed: ${error.message}`);
    }
  }

  findAll(tenantId = 'local') {
    return this.read(tenantId);
  }

  findById(id, tenantId = 'local') {
    return this.read(tenantId).find(memory => memory.id === id) || null;
  }

  insert(memory, tenantId = 'local') {
    const memories = this.readRaw().map(item => this.normalize(item, 'local'));
    const stored = this.normalize({ ...memory, tenantId }, tenantId);

    memories.unshift(stored);

    this.write(memories);

    return stored;
  }

  deleteById(id, tenantId = 'local') {
    const memories = this.readRaw().map(item => this.normalize(item, 'local'));
    const index = memories.findIndex(memory => memory.id === id && memory.tenantId === tenantId);

    if (index === -1) {
      return false;
    }

    memories.splice(index, 1);
    this.write(memories);

    return true;
  }
}

module.exports = JsonMemoryRepository;
