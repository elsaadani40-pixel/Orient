'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { PostgresTrustManifestVersionStore } = require('../../src/infrastructure/evidence/postgres-trust-manifest-version-store');

test('PostgreSQL trust manifest CAS serializes concurrent writers and survives pool restart', {
  skip: !process.env.DATABASE_URL
}, async t => {
  const connectionString = process.env.DATABASE_URL;
  const adminPool = new Pool({ connectionString, max: 4, application_name: 'orient-trust-manifest-store-integration' });
  const schema = `orient_trust_test_${crypto.randomBytes(6).toString('hex')}`;
  let restartedPool;
  t.after(async () => {
    if (restartedPool) await restartedPool.end();
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await adminPool.end();
    }
  });

  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await adminPool.query(`
    CREATE TABLE "${schema}".orient_trust_manifest_state (
      singleton_id text PRIMARY KEY CHECK (singleton_id='active'),
      version bigint NOT NULL CHECK (version > 0),
      digest char(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);

  const store = new PostgresTrustManifestVersionStore({ pool: adminPool, schema });
  assert.equal(await store.read(), null);
  const v1 = { version: 1, digest: '1'.repeat(64) };
  assert.equal(await store.compareAndSet(null, v1), true);
  assert.deepEqual(await store.read(), v1);

  const candidates = [
    { version: 2, digest: '2'.repeat(64) },
    { version: 3, digest: '3'.repeat(64) }
  ];
  const results = await Promise.all(candidates.map(next => store.compareAndSet(v1, next)));
  assert.equal(results.filter(Boolean).length, 1);
  const accepted = await store.read();
  assert.ok([2, 3].includes(accepted.version));
  assert.equal(accepted.digest, String(accepted.version).repeat(64));

  restartedPool = new Pool({ connectionString, max: 1, application_name: 'orient-trust-manifest-restarted-reader' });
  const afterRestart = new PostgresTrustManifestVersionStore({ pool: restartedPool, schema });
  assert.deepEqual(await afterRestart.read(), accepted);
  assert.equal(await afterRestart.compareAndSet(v1, { version: accepted.version + 1, digest: 'f'.repeat(64) }), false);
});
