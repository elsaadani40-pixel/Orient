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

  _recoverUnlocked() {
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

  // Startup recovery must participate in the same inter-process lock as writes;
  // otherwise a second process could roll back a transaction that is still live.
  recover() {
    const owner = this.acquireLock();
    try {
      return this._recoverUnlocked();
    } finally {
      this.releaseLock(owner);
    }
  }

  quarantineStaleLock(expectedStat, isStale) {
    // Only one process may inspect and quarantine a stale lock at a time.
    // The recovery directory is itself acquired atomically with mkdir.
    const recoveryLock = `${this.lockFile}.recovery`;
    try {
      fs.mkdirSync(recoveryLock, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }

    try {
      let currentStat;
      try { currentStat = fs.lstatSync(this.lockFile); } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
      }
      if (currentStat.dev !== expectedStat.dev || currentStat.ino !== expectedStat.ino ||
          !isStale(currentStat)) return false;

      const quarantine = `${this.lockFile}.stale.${crypto.randomUUID()}`;
      // Stale-lock removals are serialized by recoveryLock, so another
      // recovery contender cannot replace the path between validation and rename.
      fs.renameSync(this.lockFile, quarantine);
      try { fs.unlinkSync(quarantine); } catch {}
      return true;
    } finally {
      try { fs.rmdirSync(recoveryLock); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  acquireLock() {
    const owner = {
      token: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(),
      acquiredAt: new Date().toISOString()
    };
    let createdLockIdentity = null;
    try {
      const fd = fs.openSync(this.lockFile, 'wx', 0o600);
      try {
        const stat = fs.fstatSync(fd);
        createdLockIdentity = { dev: stat.dev, ino: stat.ino };
        fs.writeFileSync(fd, JSON.stringify(owner) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      syncDirectory(path.dirname(this.lockFile));
      return owner;
    } catch (error) {
      // Clean up only the inode created here if initialization or directory
      // sync fails; never leave an unusable lock or unlink a replacement.
      if (createdLockIdentity) {
        try {
          const current = fs.lstatSync(this.lockFile);
          if (current.dev === createdLockIdentity.dev && current.ino === createdLockIdentity.ino) {
            fs.unlinkSync(this.lockFile);
            syncDirectory(path.dirname(this.lockFile));
          }
        } catch (cleanupError) {
          if (!['ENOENT', 'EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(cleanupError.code)) {
            error.cleanupError = cleanupError;
          }
        }
      }
      if (error.code !== 'EEXIST') throw error;
      let current;
      let lockStat;
      try {
        current = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      } catch {
        // A process can die after exclusive creation but before its owner record
        // reaches disk. Serialize stale reclamation to prevent competing
        // recoverers from renaming one another's replacement lock.
        try { lockStat = fs.lstatSync(this.lockFile); } catch (statError) {
          if (statError.code === 'ENOENT') return this.acquireLock();
          throw statError;
        }
        const malformedLockIsStale = stat =>
          Date.now() - stat.mtimeMs > this.lockTimeoutMs;
        if (malformedLockIsStale(lockStat)) {
          if (this.quarantineStaleLock(lockStat, malformedLockIsStale)) {
            return this.acquireLock();
          }
        }
      }
      if (current && current.hostname === os.hostname() &&
          Number.isInteger(current.pid) && current.pid > 0) {
        let alive = true;
        try { process.kill(current.pid, 0); } catch (probeError) {
          if (probeError.code === 'ESRCH') alive = false;
          else if (probeError.code !== 'EPERM') throw probeError;
        }
        if (!alive) {
          try { lockStat = fs.lstatSync(this.lockFile); } catch (statError) {
            if (statError.code === 'ENOENT') return this.acquireLock();
            throw statError;
          }
          const deadOwnerIsStale = () => {
            let latest;
            try { latest = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { return false; }
            if (latest.token !== current.token || latest.pid !== current.pid ||
                latest.hostname !== current.hostname) return false;
            try { process.kill(latest.pid, 0); return false; } catch (probeError) {
              return probeError.code === 'ESRCH';
            }
          };
          if (this.quarantineStaleLock(lockStat, deadOwnerIsStale)) {
            return this.acquireLock();
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

  read(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const deadline = Date.now() + this.lockTimeoutMs;
    let owner;
    while (!owner) {
      try {
        owner = this.acquireLock();
      } catch (error) {
        if (error.code !== 'MEMORY_TRANSACTION_LOCKED' || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      // Readers must not observe the memory/audit pair between its writes.
      // Recover any abandoned prepared journal while holding the same lock.
      this._recoverUnlocked();
      return operation();
    } finally {
      this.releaseLock(owner);
    }
  }

  // Reconciliation must not wait behind a live mutation: while the writer
  // holds the lock, its memory/audit pair is intentionally incomplete. Return
  // an explicit unavailable snapshot so callers can fail closed as unknown.
  tryRead(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    let owner;
    try {
      owner = this.acquireLock();
    } catch (error) {
      if (error.code === 'MEMORY_TRANSACTION_LOCKED') return { acquired: false };
      throw error;
    }
    try {
      this._recoverUnlocked();
      return { acquired: true, value: operation() };
    } finally {
      this.releaseLock(owner);
    }
  }

  run(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const owner = this.acquireLock();
    try {
      this._recoverUnlocked();
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
        try { this._recoverUnlocked(); }
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
      this._recoverUnlocked();
      return result;
    } finally {
      this.releaseLock(owner);
    }
  }
}

module.exports = MemoryTransactionCoordinator;
