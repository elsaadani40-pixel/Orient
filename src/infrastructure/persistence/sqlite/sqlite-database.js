'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');

class SqliteDatabase {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
    this.filePath = filePath === ':memory:' ? ':memory:' : path.resolve(filePath);
    if (this.filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
    this.baseConnection = new DatabaseSync(this.filePath);
    this.transactionContext = new AsyncLocalStorage();
    this.asyncTransactionTail = Promise.resolve();
    this.asyncTransactionPending = 0;
    this.baseConnection.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    this.initialize();
  }

  run(sql, params = []) {
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL statement is required');
    if (!Array.isArray(params)) throw new TypeError('SQL parameters must be an array');
    if (params.length === 0 && sql.trim().includes(';') && sql.trim().split(';').filter(part => part.trim()).length > 1) {
      throw new TypeError('run() accepts one prepared statement; use exec() only for static SQL batches');
    }
    return this.connection.prepare(sql).run(...params);
  }

  query(sql, params = []) {
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL statement is required');
    this.assertExternalAccess(sql, 'read');
    if (!Array.isArray(params)) throw new TypeError('SQL parameters must be an array');
    return this.connection.prepare(sql).all(...params);
  }

  exec(sql) {
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL batch is required');
    this.assertExternalAccess(sql, 'write');
    return this.connection.exec(sql);
  }

  get connection() {
    const context = this.transactionContext.getStore();
    if (context?.connection) return context.connection;
    if (this.asyncTransactionPending > 0) {
      const error = new Error('SQLite connection is reserved by an asynchronous transaction');
      error.code = 'SQLITE_TRANSACTION_BUSY';
      throw error;
    }
    return this.baseConnection;
  }

  afterCommit(callback) {
    if (typeof callback !== 'function') throw new TypeError('afterCommit requires a callback');
    const context = this.transactionContext.getStore();
    if (context && Array.isArray(context.afterCommitCallbacks)) {
      context.afterCommitCallbacks.push(callback);
      return;
    }
    callback();
  }

  transaction(workOrStatements) {
    const active = this.transactionContext.getStore();
    const callback = typeof workOrStatements === 'function' ? workOrStatements : null;
    const statements = callback ? null : workOrStatements;
    if (!callback && (!Array.isArray(statements) || !statements.length)) return;

    // Nested repository transactions participate in the outer transaction.
    if (active) {
      if (callback) {
        if (callback.constructor?.name === 'AsyncFunction') {
          throw Object.assign(new TypeError('SQLite transaction callbacks must be synchronous'), {
            code: 'SQLITE_ASYNC_TRANSACTION_UNSUPPORTED'
          });
        }
        const result = callback(this);
        if (result && typeof result.then === 'function') {
          throw Object.assign(new TypeError('SQLite transaction callbacks must be synchronous'), {
            code: 'SQLITE_ASYNC_TRANSACTION_UNSUPPORTED'
          });
        }
        return result;
      }
      for (const statement of statements) {
        if (typeof statement === 'string') active.connection.exec(statement);
        else {
          if (!statement || typeof statement.sql !== 'string' || !Array.isArray(statement.params || [])) {
            throw new TypeError('Transaction statements must be SQL strings or { sql, params } objects');
          }
          active.connection.prepare(statement.sql).run(...(statement.params || []));
        }
      }
      return;
    }

    this.assertExternalAccess('BEGIN IMMEDIATE', 'write');
    const connection = this.connection;
    const context = { connection, afterCommitCallbacks: [] };
    connection.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.transactionContext.run(context, () => {
        if (callback) {
          if (callback.constructor?.name === 'AsyncFunction') {
            throw Object.assign(new TypeError('SQLite transaction callbacks must be synchronous; async functions are rejected before execution'), {
              code: 'SQLITE_ASYNC_TRANSACTION_UNSUPPORTED'
            });
          }
          const value = callback(this);
          if (value && typeof value.then === 'function') {
            throw Object.assign(new TypeError('SQLite transaction callbacks must be synchronous; async callbacks are not supported'), {
              code: 'SQLITE_ASYNC_TRANSACTION_UNSUPPORTED'
            });
          }
          return value;
        }
        for (const statement of statements) {
          if (typeof statement === 'string') {
            // String batches are reserved for static schema/test SQL.
            context.connection.exec(statement);
          } else {
            if (!statement || typeof statement.sql !== 'string' || !Array.isArray(statement.params || [])) {
              throw new TypeError('Transaction statements must be SQL strings or { sql, params } objects');
            }
            context.connection.prepare(statement.sql).run(...(statement.params || []));
          }
        }
        return undefined;
      });
      connection.exec('COMMIT;');
      for (const afterCommit of context.afterCommitCallbacks) {
        try { this.transactionContext.run(context, afterCommit); } catch (error) {
          this.lastAfterCommitError = error;
        }
      }
      return result;
    } catch (error) {
      try { connection.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  transactionAsync(work) {
    if (typeof work !== 'function') throw new TypeError('transactionAsync(work) requires a callback');
    const active = this.transactionContext.getStore();
    if (active) return Promise.resolve(work(this));

    const execute = async () => {
      const ownsConnection = this.filePath !== ':memory:';
      const connection = ownsConnection
        ? new DatabaseSync(this.filePath)
        : this.baseConnection;
      connection.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const context = { connection, afterCommitCallbacks: [] };
      connection.exec('BEGIN IMMEDIATE;');
      try {
        const result = await this.transactionContext.run(context, () => work(this));
        connection.exec('COMMIT;');
        for (const afterCommit of context.afterCommitCallbacks) {
          try {
            await this.transactionContext.run(context, afterCommit);
          } catch (error) {
            this.lastAfterCommitError = error;
          }
        }
        return result;
      } catch (error) {
        try { connection.exec('ROLLBACK;'); } catch {}
        throw error;
      } finally {
        if (ownsConnection) connection.close();
      }
    };

    // Transactions are serialized. Calls outside the active transaction context
    // fail closed while it is pending instead of accidentally joining its writes.
    this.asyncTransactionPending += 1;
    const result = this.asyncTransactionTail.then(execute, execute).finally(() => {
      this.asyncTransactionPending -= 1;
    });
    this.asyncTransactionTail = result.catch(() => {});
    return result;
  }

  async readAsync(work) {
    return this.transactionAsync(work);
  }

  async tryReadAsync(work) {
    if (this.asyncTransactionPending > 0) return { acquired: false };
    return { acquired: true, value: await this.transactionAsync(work) };
  }

  initialize() {
    this.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        execution_id TEXT,
        goal_id TEXT,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_execution ON events(execution_id);
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        execution_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        checkpoint_id TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflows_tenant_state ON workflows(tenant_id, state);

      CREATE INDEX IF NOT EXISTS idx_workflows_approval_execution
        ON workflows(tenant_id, json_extract(payload, '$.metadata.approvalExecutionId'))
        WHERE json_extract(payload, '$.metadata.approvalBlocked') = 1;
      CREATE TABLE IF NOT EXISTS workflow_leases (
        workflow_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE,
        worker_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_leases_expiry ON workflow_leases(expires_at);
      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (tenant_id, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memories_tenant_scope_created
        ON memories(tenant_id, scope, created_at DESC);
      CREATE TABLE IF NOT EXISTS memory_audit (
        event_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        memory_id TEXT,
        operation_id TEXT,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (tenant_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_audit_tenant_memory
        ON memory_audit(tenant_id, scope, memory_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_memory_audit_tenant_operation
        ON memory_audit(tenant_id, scope, operation_id, occurred_at);
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        plan_revision INTEGER NOT NULL,
        tool TEXT NOT NULL,
        capability TEXT NOT NULL,
        scope TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        used_at TEXT,
        metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_execution ON approvals(execution_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_expiry ON approvals(expires_at);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
    `);
  }

  close() {
    if (this.asyncTransactionPending > 0) {
      const error = new Error('Cannot close SQLite while asynchronous transactions are pending');
      error.code = 'SQLITE_TRANSACTION_BUSY';
      throw error;
    }
    this.baseConnection.close();
  }
}

module.exports = SqliteDatabase;
