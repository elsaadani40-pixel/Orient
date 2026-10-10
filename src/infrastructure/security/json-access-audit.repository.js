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

function capacityFailure() {
  return Object.assign(new Error('Access audit event exceeds the configured file limit'), {
    code: 'ACCESS_AUDIT_EVENT_TOO_LARGE'
  });
}

class JsonAccessAuditRepository {
  constructor(filePath, { maxFileBytes = 5 * 1024 * 1024, maxArchives = 3 } = {}) {
    if (!filePath || typeof filePath !== 'string') {
      throw new TypeError('filePath is required');
    }
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1024) {
      throw new RangeError('maxFileBytes must be an integer of at least 1024');
    }
    if (!Number.isInteger(maxArchives) || maxArchives < 1 || maxArchives > 20) {
      throw new RangeError('maxArchives must be an integer from 1 to 20');
    }
    this.filePath = path.resolve(filePath);
    this.maxFileBytes = maxFileBytes;
    this.maxArchives = maxArchives;
    this.queue = Promise.resolve();
    this.previousHash = null;
    this.initialized = false;
  }

  async listLogPaths() {
    const archives = [];
    for (let index = this.maxArchives; index >= 1; index -= 1) {
      const archivePath = this.filePath + '.' + index;
      try {
        await fs.access(archivePath);
        archives.push(archivePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { paths: [...archives, this.filePath], hasArchives: archives.length > 0 };
  }

  async readVerifiedRecords() {
    const { paths, hasArchives } = await this.listLogPaths();
    const records = [];
    let expectedPreviousHash = null;
    let firstRecord = true;
    let lastHash = null;

    for (const filePath of paths) {
      let contents;
      try {
        contents = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }

      for (const line of contents.split('\n').filter(Boolean)) {
        let record;
        try {
          record = JSON.parse(line);
        } catch (_) {
          throw integrityFailure();
        }
        const { integrity, ...event } = record;

        // Retention may have removed older segments. The first retained record
        // becomes the explicit trust anchor; all retained links are still checked.
        if (firstRecord && hasArchives) {
          expectedPreviousHash = integrity?.previousHash ?? null;
        }

        const expectedHash = hashEvent(expectedPreviousHash, event);
        if (
          integrity?.algorithm !== 'sha256-chain-v1' ||
          integrity.previousHash !== expectedPreviousHash ||
          integrity.hash !== expectedHash
        ) {
          throw integrityFailure();
        }

        expectedPreviousHash = expectedHash;
        lastHash = expectedHash;
        records.push({ event, hash: expectedHash });
        firstRecord = false;
      }
    }

    return { records, lastHash };
  }

  async initialize() {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(path.dirname(this.filePath), 0o700);
    } catch (_) {
      // Some filesystems do not support POSIX modes; deployment permissions still require review.
    }

    const verified = await this.readVerifiedRecords();
    this.previousHash = verified.lastHash;
    this.initialized = true;
  }

  async rotateIfNeeded(incomingBytes) {
    if (incomingBytes > this.maxFileBytes) throw capacityFailure();

    let stats;
    try {
      stats = await fs.stat(this.filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stats.size === 0 || stats.size + incomingBytes <= this.maxFileBytes) return;

    await fs.rm(this.filePath + '.' + this.maxArchives, { force: true });
    for (let index = this.maxArchives; index >= 2; index -= 1) {
      try {
        await fs.rename(this.filePath + '.' + (index - 1), this.filePath + '.' + index);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await fs.rename(this.filePath, this.filePath + '.1');
  }

  async listRecent(limit = 100) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 100;
    await this.queue;
    await this.initialize();
    const { records } = await this.readVerifiedRecords();
    return records.slice(-boundedLimit).reverse().map(({ event }) => ({
      eventId: event.eventId,
      requestId: event.requestId,
      timestamp: event.timestamp,
      sourceIp: event.sourceIp,
      method: event.method,
      route: event.route,
      statusCode: event.statusCode,
      userAgent: event.userAgent,
      durationMs: event.durationMs,
      authenticationOutcome: event.authenticationOutcome
    }));
  }

  record(event) {
    const operation = this.queue.then(async () => {
      await this.initialize();
      const previousHash = this.previousHash;
      const hash = hashEvent(previousHash, event);
      const line = JSON.stringify({
        ...event,
        integrity: { algorithm: 'sha256-chain-v1', previousHash, hash }
      }) + '\n';
      await this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
      await fs.appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
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
