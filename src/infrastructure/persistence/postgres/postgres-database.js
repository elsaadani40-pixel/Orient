const crypto = require('crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_tenant_updated
  ON executions(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  execution_id TEXT,
  goal_id TEXT,
  type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tenant_execution
  ON events(tenant_id, execution_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_timestamp
  ON events(tenant_id, timestamp);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  tenant_id TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_tenant
  ON idempotency(tenant_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  execution_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  checkpoint_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  snapshot_sha256 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_tenant
  ON checkpoints(tenant_id);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant_state
  ON workflows(tenant_id, state);

CREATE TABLE IF NOT EXISTS workflow_leases (
  workflow_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_leases_expiry
  ON workflow_leases(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  plan_revision INTEGER NOT NULL,
  tool TEXT NOT NULL,
  capability TEXT NOT NULL,
  scope JSONB NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  metadata JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_execution
  ON approvals(tenant_id, execution_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_expiry
  ON approvals(tenant_id, expires_at);

INSERT INTO schema_migrations(version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;
`;

class PostgresDatabase {
  constructor({ pool, schema = SCHEMA } = {}) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('pool with query(sql, params) is required');
    }
    this.pool = pool;
    this.schema = schema;
  }

  async initialize() {
    await this.pool.query(this.schema);
  }

  async query(text, values = []) {
    return this.pool.query(text, values);
  }

  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  static json(value) {
    return value === undefined ? null : value;
  }

  static uuid() {
    return crypto.randomUUID();
  }
}

module.exports = { PostgresDatabase, SCHEMA };
