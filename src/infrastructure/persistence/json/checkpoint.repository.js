const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CheckpointRepository {
  constructor(filePath) {
    if (!filePath) throw new TypeError('filePath is required');
    this.filePath = filePath;
    this.ensureStorage();
  }

  ensureStorage() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '{}\n', 'utf8');
    }
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
    const temporaryFile = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(temporaryFile, JSON.stringify(records, null, 2) + '\n', 'utf8');
      fs.renameSync(temporaryFile, this.filePath);
    } catch (error) {
      try { if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile); } catch {}
      throw new Error(`Checkpoint storage write failed: ${error.message}`);
    }
  }

  digest(snapshot) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex');
  }

  save(snapshot, { reason = 'step_completed' } = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new TypeError('snapshot must be an object');
    }
    if (!snapshot.executionId) {
      throw new TypeError('snapshot.executionId is required');
    }

    const records = this.read();
    const previous = records[snapshot.executionId];
    const sequence = Number(previous?.sequence || 0) + 1;
    const storedSnapshot = JSON.parse(JSON.stringify(snapshot));

    const checkpoint = {
      checkpointId: crypto.randomUUID(),
      executionId: snapshot.executionId,
      sequence,
      reason,
      createdAt: new Date().toISOString(),
      snapshot: storedSnapshot,
      snapshotSha256: this.digest(storedSnapshot)
    };

    records[snapshot.executionId] = checkpoint;
    this.write(records);
    return JSON.parse(JSON.stringify(checkpoint));
  }

  findLatest(executionId, { verify = true, tenantId = null } = {}) {
    if (!executionId) return null;
    const checkpoint = this.read()[executionId] || null;
    if (!checkpoint) return null;
    if (tenantId && checkpoint.snapshot?.metadata?.tenantId !== tenantId) return null;

    if (verify && checkpoint.snapshotSha256 !== this.digest(checkpoint.snapshot)) {
      const error = new Error(`Checkpoint integrity verification failed: ${executionId}`);
      error.code = 'CHECKPOINT_INTEGRITY_FAILED';
      throw error;
    }

    return JSON.parse(JSON.stringify(checkpoint));
  }

  delete(executionId) {
    const records = this.read();
    if (!records[executionId]) return false;
    delete records[executionId];
    this.write(records);
    return true;
  }

  clear() {
    this.write({});
  }

  count() {
    return Object.keys(this.read()).length;
  }
}

module.exports = CheckpointRepository;
