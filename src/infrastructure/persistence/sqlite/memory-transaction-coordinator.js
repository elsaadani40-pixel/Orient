'use strict';

/**
 * Transaction boundary for SQLite-backed memory and its audit receipts.
 * SQLite/WAL owns crash recovery; this coordinator makes every synchronous
 * MemoryService mutation commit memory rows and audit rows atomically.
 */
class SqliteMemoryTransactionCoordinator {
  constructor(db) {
    if (!db || typeof db.exec !== 'function') {
      throw new TypeError('A SQLite database connection is required');
    }
    this.db = db;
    this.depth = 0;
    this.afterCommitCallbacks = [];
  }

  assertSynchronous(result) {
    if (result && typeof result.then === 'function') {
      throw new TypeError('SQLite memory transactions must be synchronous');
    }
    return result;
  }

  run(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    if (this.depth > 0) return this.assertSynchronous(operation());

    this.db.exec('BEGIN IMMEDIATE;');
    this.depth = 1;
    this.afterCommitCallbacks = [];
    try {
      const result = this.assertSynchronous(operation());
      this.db.exec('COMMIT;');
      const callbacks = this.afterCommitCallbacks;
      this.afterCommitCallbacks = [];
      this.depth = 0;
      for (const callback of callbacks) {
        try { callback(); } catch (error) { this.lastAfterCommitError = error; }
      }
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
        error.code = error.code || 'MEMORY_TRANSACTION_ROLLBACK_FAILED';
      }
      this.afterCommitCallbacks = [];
      this.depth = 0;
      throw error;
    }
  }

  read(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    if (this.depth > 0) return operation();

    this.db.exec('BEGIN;');
    this.depth = 1;
    try {
      const result = this.assertSynchronous(operation());
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  tryRead(operation) {
    try {
      return { acquired: true, value: this.read(operation) };
    } catch (error) {
      if (error.errcode === 5 || error.errcode === 6 ||
          /database is (?:locked|busy)/i.test(error.message || '')) {
        return { acquired: false };
      }
      throw error;
    }
  }

  afterCommit(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (this.depth > 0) {
      this.afterCommitCallbacks.push(callback);
      return;
    }
    callback();
  }

  // SQLite rolls back an interrupted transaction when the database is reopened.
  recover() {
    return { recovered: false, phase: null };
  }
}

module.exports = SqliteMemoryTransactionCoordinator;
