'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRuntimeDatabaseRole, RUNTIME_ROLE_QUERY } = require('../../../../src/infrastructure/persistence/postgres/assert-runtime-database-role');

function identity(overrides = {}) {
  return {
    session_user: 'orient_runtime_login', current_user: 'orient_runtime_login',
    login_is_superuser: false, login_bypasses_rls: false,
    login_can_create_database: false, login_can_create_roles: false,
    login_can_replicate: false, login_inherits_roles: true,
    runtime_is_superuser: false, runtime_bypasses_rls: false,
    runtime_can_create_database: false, runtime_can_create_roles: false,
    runtime_can_replicate: false, runtime_can_login: false,
    has_runtime_membership: true, has_owner_membership: false,
    can_create_any_schema_objects: false, owns_application_relations: false,
    ...overrides
  };
}

test('runtime preflight accepts only the least-privilege runtime login', async () => {
  const pool = { async query(sql) { assert.equal(sql, RUNTIME_ROLE_QUERY); return { rows: [identity()] }; } };
  assert.deepEqual(await assertRuntimeDatabaseRole(pool), {
    role: 'orient_runtime_login', leastPrivilege: true
  });
});

test('runtime preflight rejects admin, owner, and elevated runtime identities', async () => {
  const invalid = [
    identity({ session_user: 'postgres', current_user: 'postgres', login_is_superuser: true, login_bypasses_rls: true }),
    identity({ current_user: 'orient_owner' }),
    identity({ login_can_create_roles: true }),
    identity({ runtime_bypasses_rls: true }),
    identity({ runtime_can_login: true }),
    identity({ has_owner_membership: true }),
    identity({ has_runtime_membership: false }),
    identity({ can_create_any_schema_objects: true }),
    identity({ owns_application_relations: true }),
    identity({ login_inherits_roles: false })
  ];
  for (const row of invalid) {
    await assert.rejects(
      () => assertRuntimeDatabaseRole({ async query() { return { rows: [row] }; } }),
      error => error.code === 'PERSISTENCE_RUNTIME_ROLE_INVALID'
    );
  }
  await assert.rejects(() => assertRuntimeDatabaseRole({ async query() { return { rows: [] }; } }), /least-privilege/);
  await assert.rejects(() => assertRuntimeDatabaseRole({}), TypeError);
});
