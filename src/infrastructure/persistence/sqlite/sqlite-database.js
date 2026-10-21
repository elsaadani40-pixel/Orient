'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class SqliteDatabase {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
    this.filePath = filePath === ':memory:' ? ':memory:' : path.resolve(filePath);
    if (this.filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
    this.connection = new DatabaseSync(this.filePath);
    this.connection.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
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
    if (!Array.isArray(params)) throw new TypeError('SQL parameters must be an array');
    return this.connection.prepare(sql).all(...params);
  }

  exec(sql) {
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL batch is required');
    return this.connection.exec(sql);
  }

  transaction(statements) {
    if (!Array.isArray(statements) || !statements.length) return;
    this.connection.exec('BEGIN IMMEDIATE;');
    try {
      for (const statement of statements) {
        if (typeof statement === 'string') {
          // String batches are reserved for static schema/test SQL. Dynamic
          // values must be passed through { sql, params } prepared statements.
          this.connection.exec(statement);
          continue;
        }
        if (!statement || typeof statement.sql !== 'string' || !Array.isArray(statement.params || [])) {
          throw new TypeError('Transaction statements must be SQL strings or { sql, params } objects');
        }
        this.connection.prepare(statement.sql).run(...(statement.params || []));
      }
      this.connection.exec('COMMIT;');
    } catch (error) {
      try { this.connection.exec('ROLLBACK;'); } catch {}
      throw error;
    }
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
    this.connection.close();
  }
}

module.exports = SqliteDatabase;
