const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresDatabase, MIGRATIONS } = require('../../../../src/infrastructure/persistence/postgres/postgres-database');

test('PostgreSQL runtime initialization is read-only and refuses an absent schema', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      return { rows: [{ ready: false }] };
    },
    async connect() {
      throw new Error('runtime initialization must not acquire a migration client');
    }
  };
  const database = new PostgresDatabase({ pool });

  await assert.rejects(
    () => database.initialize(),
    error => error.code === 'PERSISTENCE_SCHEMA_NOT_READY'
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /to_regclass/);
  assert.equal(calls.some(sql => /CREATE TABLE|ALTER TABLE|INSERT INTO/i.test(sql)), false);
});

test('PostgreSQL runtime initialization only verifies the installed schema version', async () => {
  const calls = [];
  const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (/to_regclass/.test(sql)) return { rows: [{ ready: true }] };
      return { rows: [{ version: latest }] };
    },
    async connect() {
      throw new Error('runtime initialization must not acquire a migration client');
    }
  };
  const database = new PostgresDatabase({ pool });

  assert.deepEqual(await database.initialize(), { schemaVersion: latest });
  assert.equal(calls.length, 2);
  assert.equal(calls.some(sql => /CREATE TABLE|ALTER TABLE|INSERT INTO/i.test(sql)), false);
});

test('PostgreSQL runtime initialization rejects an outdated schema', async () => {
  const pool = {
    async query(sql) {
      if (/to_regclass/.test(sql)) return { rows: [{ ready: true }] };
      return { rows: [{ version: 1 }] };
    },
    async connect() {
      throw new Error('runtime initialization must not acquire a migration client');
    }
  };
  const database = new PostgresDatabase({ pool });

  await assert.rejects(
    () => database.initialize(),
    error => error.code === 'PERSISTENCE_SCHEMA_OUTDATED'
      && error.currentVersion === 1
      && error.expectedVersion === Math.max(...MIGRATIONS.map(migration => migration.version))
  );
});
