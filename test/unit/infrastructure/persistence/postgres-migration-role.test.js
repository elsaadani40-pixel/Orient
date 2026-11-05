const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertMigrationDatabaseRole,
  MIGRATION_ROLE_QUERY
} = require('../../../../src/infrastructure/persistence/postgres/assert-migration-database-role');

function validIdentity(overrides = {}) {
  return {
    session_user: 'orient_migrator',
    current_user: 'orient_migrator',
    is_superuser: false,
    bypasses_rls: false,
    can_create_database: false,
    can_create_roles: false,
    can_replicate: false,
    inherits_roles: false,
    can_login: true,
    has_owner_membership: true,
    can_set_owner_role: true,
    has_runtime_membership: false,
    can_create_public_schema_objects: false,
    owns_application_relations: false,
    ...overrides
  };
}

test('migration preflight accepts only the restricted migrator login with explicit owner SET ROLE', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      return { rows: [validIdentity()] };
    }
  };

  assert.deepEqual(await assertMigrationDatabaseRole(pool), {
    role: 'orient_migrator',
    targetRole: 'orient_owner',
    leastPrivilege: true
  });
  assert.deepEqual(calls, [MIGRATION_ROLE_QUERY]);
});

test('migration preflight rejects runtime and administrative connections', async () => {
  for (const identity of [
    validIdentity({ session_user: 'postgres', current_user: 'postgres', is_superuser: true }),
    validIdentity({ session_user: 'orient_runtime_login', current_user: 'orient_runtime_login' }),
    validIdentity({ current_user: 'orient_owner' })
  ]) {
    const pool = { async query() { return { rows: [identity] }; } };
    await assert.rejects(
      () => assertMigrationDatabaseRole(pool),
      error => error.code === 'PERSISTENCE_MIGRATION_ROLE_INVALID'
    );
  }
});

test('migration preflight rejects excessive attributes, wrong memberships, and ownership', async () => {
  for (const identity of [
    validIdentity({ is_superuser: true }),
    validIdentity({ bypasses_rls: true }),
    validIdentity({ can_create_database: true }),
    validIdentity({ can_create_roles: true }),
    validIdentity({ can_replicate: true }),
    validIdentity({ inherits_roles: true }),
    validIdentity({ can_login: false }),
    validIdentity({ has_owner_membership: false }),
    validIdentity({ can_set_owner_role: false }),
    validIdentity({ has_runtime_membership: true }),
    validIdentity({ can_create_public_schema_objects: true }),
    validIdentity({ owns_application_relations: true })
  ]) {
    const pool = { async query() { return { rows: [identity] }; } };
    await assert.rejects(
      () => assertMigrationDatabaseRole(pool),
      error => error.code === 'PERSISTENCE_MIGRATION_ROLE_INVALID'
    );
  }
});

test('migration preflight rejects missing role metadata and invalid pools', async () => {
  await assert.rejects(
    () => assertMigrationDatabaseRole({ async query() { return { rows: [] }; } }),
    error => error.code === 'PERSISTENCE_MIGRATION_ROLE_INVALID'
  );
  await assert.rejects(
    () => assertMigrationDatabaseRole({}),
    TypeError
  );
});
