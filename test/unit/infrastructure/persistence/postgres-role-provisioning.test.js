'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { provisionPostgresRoles } = require('../../../../scripts/provision-postgres-roles');

test('role provisioning creates four separated roles and revokes broad future defaults', async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql === 'SELECT 1 FROM pg_roles WHERE rolname = $1') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM pg_auth_members')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM pg_tables')) return { rowCount: 0, rows: [{ tablename: 'executions' }] };
      if (sql.includes('FROM information_schema.sequences')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };

  const result = await provisionPostgresRoles({
    pool, migratorPassword: 'm'.repeat(32), runtimePassword: 'r'.repeat(32)
  });
  const sql = statements.map(item => item.sql);

  assert.deepEqual(result.ownedTables, ['executions']);
  assert.ok(sql.some(statement => statement.includes('CREATE ROLE orient_owner NOLOGIN NOINHERIT')));
  assert.ok(sql.some(statement => statement.includes('CREATE ROLE orient_runtime NOLOGIN NOINHERIT')));
  assert.ok(sql.some(statement => statement.includes('CREATE ROLE orient_migrator LOGIN NOINHERIT')));
  assert.ok(sql.some(statement => statement.includes('CREATE ROLE orient_runtime_login LOGIN INHERIT')));
  assert.ok(sql.includes('GRANT orient_owner TO orient_migrator'));
  assert.ok(sql.includes('GRANT orient_runtime TO orient_runtime_login'));
  assert.ok(sql.includes('ALTER DEFAULT PRIVILEGES FOR ROLE orient_owner IN SCHEMA public REVOKE ALL ON TABLES FROM orient_runtime'));
  assert.ok(sql.includes('ALTER DEFAULT PRIVILEGES FOR ROLE orient_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM orient_runtime'));
  assert.ok(sql.includes('ALTER TABLE public.executions OWNER TO orient_owner'));
  assert.equal(sql.includes('COMMIT'), true);
});

test('role provisioning rejects missing admin pools and weak role passwords', async () => {
  await assert.rejects(
    () => provisionPostgresRoles({ pool: {}, migratorPassword: 'm'.repeat(32), runtimePassword: 'r'.repeat(32) }),
    TypeError
  );
  await assert.rejects(
    () => provisionPostgresRoles({ pool: { async connect() { throw new Error('unused'); } }, migratorPassword: 'short', runtimePassword: 'r'.repeat(32) }),
    /at least 16 characters/
  );
});
