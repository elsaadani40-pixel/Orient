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

  normalize(memory) {
    const now = new Date().toISOString();

    return {
      id: memory.id || crypto.randomUUID(),
      text: String(memory.text || '').trim(),
      createdAt: memory.createdAt || now,
      updatedAt: memory.updatedAt || memory.createdAt || now
    };
  }

  migrateLegacyData() {
    const current = this.readRaw();

    if (!current.length) {
      return;
    }

    const migrated = current.map(memory => this.normalize(memory));

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

  read() {
    return this.readRaw().map(memory => this.normalize(memory));
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

  findAll() {
    return this.read();
  }

  findById(id) {
    return this.read().find(memory => memory.id === id) || null;
  }

  insert(memory) {
    const memories = this.read();

    memories.unshift(memory);

    this.write(memories);

    return memory;
  }

  deleteById(id) {
    const memories = this.read();
    const index = memories.findIndex(memory => memory.id === id);

    if (index === -1) {
      return false;
    }

    memories.splice(index, 1);
    this.write(memories);

    return true;
  }
}

module.exports = JsonMemoryRepository;
