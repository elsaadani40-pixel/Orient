const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.txn.${process.pid}.${crypto.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Crash-recovery coordinator for the JSON memory + audit pair.
 * Prepared before-images are rolled back on startup; committed journals are
 * finalized. This is deliberately synchronous so one Node event loop cannot
 * interleave service mutations. The lock prevents concurrent process writers.
 */
class MemoryTransactionCoordinator {
  constructor({ memoryFile, auditFile, journalFile, lockTimeoutMs = 30000 }) {
    if (!memoryFile || !auditFile || !journalFile) {
      throw new TypeError('memoryFile, auditFile and journalFile are required');
    }
    this.files = [path.resolve(memoryFile), path.resolve(auditFile)];
    this.journalFile = path.resolve(journalFile);
    this.lockFile = `${this.journalFile}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
  }

  readJournal() {
    try {
      const journal = JSON.parse(fs.readFileSync(this.journalFile, 'utf8'));
      if (journal.version !== 1 || !['prepared', 'committed'].includes(journal.phase) ||
          !Array.isArray(journal.snapshots) || journal.snapshots.length !== this.files.length ||
          journal.snapshots.some((item, index) => item.path !== this.files[index] ||
            typeof item.exists !== 'boolean' ||
            (item.exists && typeof item.content !== 'string'))) {
        throw new Error('journal schema or target paths are invalid');
      }
      return journal;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      const corrupt = new Error(`Memory transaction journal is unreadable; refusing startup: ${error.message}`);
      corrupt.code = 'MEMORY_TRANSACTION_JOURNAL_CORRUPT';
      corrupt.cause = error;
      throw corrupt;
    }
  }

  recover() {
    const journal = this.readJournal();
    if (!journal) return { recovered: false, phase: null };
    if (journal.phase === 'prepared') {
      for (const snapshot of journal.snapshots) {
        if (snapshot.exists) atomicWrite(snapshot.path, snapshot.content);
        else {
          try {
            fs.unlinkSync(snapshot.path);
            syncDirectory(path.dirname(snapshot.path));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
    }
    fs.unlinkSync(this.journalFile);
    syncDirectory(path.dirname(this.journalFile));
    return { recovered: true, phase: journal.phase };
  }

  acquireLock() {
    const owner = {
      token: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(),
      acquiredAt: new Date().toISOString()
    };
    try {
      const fd = fs.openSync(this.lockFile, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(owner) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      syncDirectory(path.dirname(this.lockFile));
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current;
      try { current = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch {}
      if (current && current.hostname === os.hostname() &&
          Number.isInteger(current.pid) && current.pid > 0) {
        let alive = true;
        try { process.kill(current.pid, 0); } catch (probeError) {
          if (probeError.code === 'ESRCH') alive = false;
          else if (probeError.code !== 'EPERM') throw probeError;
        }
        if (!alive) {
          const quarantine = `${this.lockFile}.stale.${crypto.randomUUID()}`;
          try {
            fs.renameSync(this.lockFile, quarantine);
            try { fs.unlinkSync(quarantine); } catch {}
            return this.acquireLock();
          } catch (renameError) {
            if (renameError.code === 'ENOENT') return this.acquireLock();
            throw renameError;
          }
        }
      }
      const busy = new Error('Memory transaction lock is held by another process; refusing concurrent mutation');
      busy.code = 'MEMORY_TRANSACTION_LOCKED';
      throw busy;
    }
  }

  releaseLock(owner) {
    let current;
    try { current = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!current || current.token !== owner.token) {
      const error = new Error('Memory transaction lock ownership changed');
      error.code = 'MEMORY_TRANSACTION_LOCK_OWNERSHIP_LOST';
      throw error;
    }
    fs.unlinkSync(this.lockFile);
    syncDirectory(path.dirname(this.lockFile));
  }

  writeJournal(journal) {
    atomicWrite(this.journalFile, JSON.stringify(journal, null, 2) + '\n');
  }

  run(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const owner = this.acquireLock();
    try {
      this.recover();
      const snapshots = this.files.map(filePath => {
        try { return { path: filePath, exists: true, content: fs.readFileSync(filePath, 'utf8') }; }
        catch (error) {
          if (error.code === 'ENOENT') return { path: filePath, exists: false };
          throw error;
        }
      });
      const journal = {
        version: 1, id: crypto.randomUUID(), phase: 'prepared',
        createdAt: new Date().toISOString(), snapshots
      };
      this.writeJournal(journal);

      let result;
      try {
        result = operation();
      } catch (operationError) {
        try { this.recover(); }
        catch (recoveryError) {
          const fatal = new Error('Memory transaction failed and rollback recovery is incomplete');
          fatal.code = 'MEMORY_TRANSACTION_RECOVERY_FAILED';
          fatal.cause = operationError;
          fatal.recoveryError = recoveryError;
          throw fatal;
        }
        throw operationError;
      }

      journal.phase = 'committed';
      journal.committedAt = new Date().toISOString();
      this.writeJournal(journal);
      this.recover();
      return result;
    } finally {
      this.releaseLock(owner);
    }
  }
}

module.exports = MemoryTransactionCoordinator;
