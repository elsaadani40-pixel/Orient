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
