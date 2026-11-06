'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresTrustManifestVersionStore } = require('../../../../src/infrastructure/evidence/postgres-trust-manifest-version-store');

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

test('PostgreSQL trust store inserts initial state with a singleton conditional insert', async () => {
  const calls = [];
  const store = new PostgresTrustManifestVersionStore({
    pool: { async query(sql, values) { calls.push({ sql, values }); return { rowCount: 1, rows: [{ version: '1' }] }; } }
  });
  assert.equal(await store.compareAndSet(null, { version: 1, digest: digestA }), true);
  assert.match(calls[0].sql, /ON CONFLICT \(singleton_id\) DO NOTHING/);
  assert.deepEqual(calls[0].values, [1, digestA]);
});

test('PostgreSQL trust store advances only from the exact expected version and digest', async () => {
  const calls = [];
  const store = new PostgresTrustManifestVersionStore({
    pool: { async query(sql, values) { calls.push({ sql, values }); return { rowCount: 1, rows: [{ version: '2' }] }; } }
  });
  assert.equal(await store.compareAndSet({ version: 1, digest: digestA }, { version: 2, digest: digestB }), true);
  assert.match(calls[0].sql, /version=\$3 AND digest=\$4/);
  assert.match(calls[0].sql, /\$1::bigint > version/);
  assert.deepEqual(calls[0].values, [2, digestB, 1, digestA]);
});

test('PostgreSQL trust store reads durable state and validates database values', async () => {
  const store = new PostgresTrustManifestVersionStore({
    pool: { async query() { return { rows: [{ version: '7', digest: digestA }] }; } }
  });
  assert.deepEqual(await store.read(), { version: 7, digest: digestA });
  const corrupt = new PostgresTrustManifestVersionStore({
    pool: { async query() { return { rows: [{ version: '0', digest: 'bad' }] }; } }
  });
  await assert.rejects(corrupt.read(), error => error.code === 'EVIDENCE_TRUST_MANIFEST_STORE_INVALID');
});

test('PostgreSQL trust store rejects unsafe identifiers, malformed states, and non-monotonic updates', async () => {
  assert.throws(() => new PostgresTrustManifestVersionStore({
    pool: { query() {} }, schema: 'public; DROP TABLE users'
  }), /safe PostgreSQL identifiers/);
  const store = new PostgresTrustManifestVersionStore({ pool: { query() {} } });
  await assert.rejects(
    store.compareAndSet({ version: 2, digest: digestA }, { version: 2, digest: digestB }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_STORE_INVALID'
  );
});
