'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresDatabase } = require('../../../../src/infrastructure/persistence/postgres/postgres-database');

test('initialized PostgreSQL databases do not replay base-schema DDL on every initialize call', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ relation: 'schema_migrations' }], rowCount: 1 };
      }
      if (sql.includes('COALESCE(MAX(version),0)::int AS version')) {
        return { rows: [{ version: 12 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };

  await new PostgresDatabase({ pool }).initialize();

  assert.equal(calls.some(call => call.sql.includes('CREATE TABLE IF NOT EXISTS executions')), false);
  assert.equal(calls.some(call => call.sql.includes('CREATE TABLE IF NOT EXISTS workflow_leases')), false);
  assert.equal(calls.some(call => call.sql.includes('pg_advisory_xact_lock')), true);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
