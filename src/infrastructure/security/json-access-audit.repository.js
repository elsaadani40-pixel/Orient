'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

function hashEvent(previousHash, event) {
  return createHash('sha256')
    .update(previousHash || '')
    .update('\n')
    .update(JSON.stringify(event))
    .digest('hex');
}

function integrityFailure() {
  return Object.assign(new Error('Access audit integrity check failed'), {
    code: 'ACCESS_AUDIT_INTEGRITY_FAILED'
  });
}

class JsonAccessAuditRepository {
  constructor(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new TypeError('filePath is required');
    }
    this.filePath = path.resolve(filePath);
    this.queue = Promise.resolve();
    this.previousHash = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(path.dirname(this.filePath), 0o700);
    } catch (_) {
      // Some filesystems do not support POSIX modes; deployment permissions still require review.
    }

    try {
      const contents = await fs.readFile(this.filePath, 'utf8');
      const lines = contents.split('\n').filter(Boolean);
      let expectedPreviousHash = null;
      for (const line of lines) {
        let record;
        try {
          record = JSON.parse(line);
        } catch (_) {
          throw integrityFailure();
        }
        const { integrity, ...event } = record;
        const expectedHash = hashEvent(expectedPreviousHash, event);
        if (
          integrity?.algorithm !== 'sha256-chain-v1' ||
          integrity.previousHash !== expectedPreviousHash ||
          integrity.hash !== expectedHash
        ) {
          throw integrityFailure();
        }
        expectedPreviousHash = expectedHash;
      }
      this.previousHash = expectedPreviousHash;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  record(event) {
    const operation = this.queue.then(async () => {
      await this.initialize();
      const previousHash = this.previousHash;
      const hash = hashEvent(previousHash, event);
      const record = JSON.stringify({
        ...event,
        integrity: { algorithm: 'sha256-chain-v1', previousHash, hash }
      });
      await fs.appendFile(this.filePath, record + '\n', { encoding: 'utf8', mode: 0o600, flag: 'a' });
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch (_) {
        // Filesystem-specific permissions must be reviewed at deployment.
      }
      this.previousHash = hash;
      return { eventId: event.eventId, hash };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = JsonAccessAuditRepository;
