'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { provisionPostgresRoles } = require('../../../../scripts/provision-postgres-roles');

test('PostgreSQL role provisioning revokes broad default privileges for future objects', async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql === 'SELECT 1 FROM pg_roles WHERE rolname = $1') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM pg_auth_members')) {
        return {
          rowCount: 3,
          rows: [
            { granted_role: 'orient_owner', member_role: 'orient_runtime_login', grantor_role: 'postgres', grantor_is_superuser: true, admin_option: true },
            { granted_role: 'unrelated_admin', member_role: 'orient_migrator', grantor_role: 'postgres', grantor_is_superuser: true, admin_option: true },
            { granted_role: 'orient_owner', member_role: 'orient_migrator', grantor_role: 'postgres', grantor_is_superuser: true, admin_option: false }
          ]
        };
      }
      if (sql.includes('FROM pg_tables')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM information_schema.sequences')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };

  await provisionPostgresRoles({
    pool,
    migratorPassword: 'm'.repeat(32),
    runtimePassword: 'r'.repeat(32)
  });

  const sql = statements.map(item => item.sql);
  assert.ok(sql.includes(
    'ALTER DEFAULT PRIVILEGES FOR ROLE orient_owner IN SCHEMA public REVOKE ALL ON TABLES FROM orient_runtime'
  ));
  assert.ok(sql.includes(
    'ALTER DEFAULT PRIVILEGES FOR ROLE orient_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM orient_runtime'
  ));
  assert.equal(sql.some(statement =>
    /ALTER DEFAULT PRIVILEGES.*GRANT.*TO orient_runtime/i.test(statement)
  ), false);
  assert.ok(sql.includes('GRANT USAGE ON SCHEMA public TO orient_runtime'));
  assert.ok(sql.includes('REVOKE "orient_owner" FROM "orient_runtime_login"'));
  assert.ok(sql.includes('REVOKE "unrelated_admin" FROM "orient_migrator"'));
  assert.ok(sql.includes('REVOKE "orient_owner" FROM "orient_migrator"'));
  assert.equal(sql.filter(statement => statement === 'SET LOCAL ROLE "postgres"').length, 3);
  assert.equal(sql.filter(statement => statement === 'RESET ROLE').length, 3);
  assert.ok(sql.includes('GRANT orient_owner TO orient_migrator'));
  assert.ok(sql.includes('GRANT orient_runtime TO orient_runtime_login'));
});
