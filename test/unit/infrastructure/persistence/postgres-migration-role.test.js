'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertMigrationDatabaseRole, MIGRATION_ROLE_QUERY } = require('../../../../src/infrastructure/persistence/postgres/assert-migration-database-role');

function identity(overrides = {}) {
  return {
    session_user: 'orient_migrator', current_user: 'orient_migrator',
    is_superuser: false, bypasses_rls: false, can_create_database: false,
    can_create_roles: false, can_replicate: false, inherits_roles: false,
    can_login: true, has_owner_membership: true, can_set_owner_role: true,
    has_runtime_membership: false, can_create_public_schema_objects: false,
    owns_application_relations: false, ...overrides
  };
}

test('migration preflight accepts only the restricted migrator login', async () => {
  const pool = { async query(sql) { assert.equal(sql, MIGRATION_ROLE_QUERY); return { rows: [identity()] }; } };
  assert.deepEqual(await assertMigrationDatabaseRole(pool), {
    role: 'orient_migrator', targetRole: 'orient_owner', leastPrivilege: true
  });
});

test('migration preflight rejects administrative, runtime, and elevated identities', async () => {
  const invalid = [
    identity({ session_user: 'postgres', current_user: 'postgres', is_superuser: true }),
    identity({ session_user: 'orient_runtime_login', current_user: 'orient_runtime_login' }),
    identity({ current_user: 'orient_owner' }),
    identity({ bypasses_rls: true }),
    identity({ can_create_roles: true }),
    identity({ has_runtime_membership: true }),
    identity({ can_set_owner_role: false }),
    identity({ owns_application_relations: true })
  ];
  for (const row of invalid) {
    await assert.rejects(
      () => assertMigrationDatabaseRole({ async query() { return { rows: [row] }; } }),
      error => error.code === 'PERSISTENCE_MIGRATION_ROLE_INVALID'
    );
  }
  await assert.rejects(() => assertMigrationDatabaseRole({ async query() { return { rows: [] }; } }), /restricted orient_migrator/);
  await assert.rejects(() => assertMigrationDatabaseRole({}), TypeError);
});
