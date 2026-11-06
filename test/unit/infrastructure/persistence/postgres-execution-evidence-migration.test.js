'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MIGRATIONS } = require('../../../../src/infrastructure/persistence/postgres/postgres-database');
const { PostgresPersistence } = require('../../../../src/infrastructure/persistence/postgres/postgres-persistence');

test('migration 13 creates a tenant-scoped append-only evidence ledger', () => {
  const migration = MIGRATIONS.find(item => item.version === 13);
  assert.ok(migration, 'migration 13 must exist');
  const sql = migration.sql;
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS execution_evidence',
    'PRIMARY KEY (tenant_id, execution_id, sequence)',
    'UNIQUE (tenant_id, execution_id, evidence_id)',
    'ALTER TABLE execution_evidence ENABLE ROW LEVEL SECURITY',
    'TO orient_runtime',
    'GRANT SELECT, INSERT ON TABLE execution_evidence TO orient_runtime',
    'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE execution_evidence FROM orient_runtime',
    'BEFORE UPDATE OR DELETE',
    'BEFORE TRUNCATE'
  ]) {
    assert.ok(sql.includes(fragment), `migration 13 must include: ${fragment}`);
  }
  assert.ok(!/GRANT\s+ALL\s+ON\s+TABLE\s+execution_evidence\s+TO\s+orient_runtime/i.test(sql));
});

test('PostgresPersistence exposes evidence repository only with explicit signing configuration', () => {
  const pool = { query() {}, connect() {} };
  const withoutSigning = new PostgresPersistence({ pool });
  assert.equal(withoutSigning.executionEvidence, null);
  assert.equal(withoutSigning.health().repositories.executionEvidence, false);

  const evidenceSigning = {
    keyId: 'configured-key',
    privateKey: 'private-key-material',
    trustedKeys: { 'configured-key': { publicKey: 'public-key-material' } }
  };
  const withSigning = new PostgresPersistence({ pool, evidenceSigning });
  assert.ok(withSigning.executionEvidence);
  assert.equal(withSigning.health().repositories.executionEvidence, true);
});


test('migration 14 binds execution rows to the authenticated runtime owner', () => {
  const migration = MIGRATIONS.find(item => item.version === 14);
  assert.ok(migration, 'migration 14 must exist');
  const sql = migration.sql;
  for (const fragment of [
    'ADD COLUMN IF NOT EXISTS owner_id UUID',
    'idx_executions_tenant_owner_updated',
    'DROP POLICY IF EXISTS orient_tenant_scope ON public.executions',
    'CREATE POLICY orient_execution_owner_scope ON public.executions TO orient_runtime',
    "owner_id::text = current_setting('app.orient_owner_id', true)",
    "session_user <> 'orient_runtime_login' AND current_user <> 'orient_runtime'",
    "current_setting('app.orient_owner_id', true)",
    'NEW.owner_id := configured_owner::uuid',
    'ORIENT execution ownership is immutable',
    'BEFORE INSERT OR UPDATE ON public.executions'
  ]) {
    assert.ok(sql.includes(fragment), `migration 14 must include: ${fragment}`);
  }
});
