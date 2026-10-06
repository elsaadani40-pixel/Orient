const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class SqliteDatabase {
  constructor(filePath, { binary = 'sqlite3' } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    this.filePath = path.resolve(filePath);
    this.binary = binary;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.initialize();
  }

  run(sql) {
    execFileSync(this.binary, [
      '-batch',
      '-bail',
      this.filePath,
      sql
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  query(sql) {
    const output = execFileSync(this.binary, [
      '-batch',
      '-json',
      '-bail',
      this.filePath,
      sql
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();

    if (!output) return [];
    const value = JSON.parse(output);
    return Array.isArray(value) ? value : [];
  }

  transaction(statements) {
    if (!Array.isArray(statements) || !statements.length) return;
    this.run([
      'BEGIN IMMEDIATE;',
      ...statements,
      'COMMIT;'
    ].join('\n'));
  }

  initialize() {
    this.run(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;

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

      CREATE INDEX IF NOT EXISTS idx_events_execution
        ON events(execution_id);

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

      CREATE INDEX IF NOT EXISTS idx_approvals_execution
        ON approvals(execution_id);

      CREATE INDEX IF NOT EXISTS idx_approvals_expiry
        ON approvals(expires_at);
    `);
  }

  static literal(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  static json(value) {
    return SqliteDatabase.literal(JSON.stringify(value ?? null));
  }
}

module.exports = SqliteDatabase;
