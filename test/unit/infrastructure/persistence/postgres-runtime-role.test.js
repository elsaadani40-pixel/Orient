const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRuntimeDatabaseRole, RUNTIME_ROLE_QUERY } = require('../../../../src/infrastructure/persistence/postgres/assert-runtime-database-role');

function validIdentity(overrides = {}) {
  return {
    session_user: 'orient_runtime_login',
    current_user: 'orient_runtime_login',
    login_is_superuser: false,
    login_bypasses_rls: false,
    login_can_create_database: false,
    login_can_create_roles: false,
    login_can_replicate: false,
    login_inherits_roles: true,
    runtime_is_superuser: false,
    runtime_bypasses_rls: false,
    runtime_can_create_database: false,
    runtime_can_create_roles: false,
    runtime_can_replicate: false,
    runtime_can_login: false,
    has_runtime_membership: true,
    has_owner_membership: false,
    can_create_any_schema_objects: false,
    owns_application_relations: false,
    ...overrides
  };
}

test('runtime database preflight accepts only the intended least-privilege login', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      return { rows: [validIdentity()] };
    }
  };

  assert.deepEqual(await assertRuntimeDatabaseRole(pool), {
    role: 'orient_runtime_login',
    leastPrivilege: true
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], RUNTIME_ROLE_QUERY);
});

test('runtime database preflight rejects an administrative login', async () => {
  const pool = {
    async query() {
      return { rows: [validIdentity({
        session_user: 'postgres',
        current_user: 'postgres',
        login_is_superuser: true,
        login_bypasses_rls: true
      })] };
    }
  };

  await assert.rejects(
    () => assertRuntimeDatabaseRole(pool),
    error => error.code === 'PERSISTENCE_RUNTIME_ROLE_INVALID' &&
      error.details.session_user === 'postgres'
  );
});

test('runtime database preflight rejects SET ROLE and elevated runtime group attributes', async () => {
  for (const identity of [
    validIdentity({ current_user: 'orient_owner' }),
    validIdentity({ runtime_bypasses_rls: true }),
    validIdentity({ runtime_can_create_roles: true }),
    validIdentity({ runtime_can_login: true }),
    validIdentity({ can_create_any_schema_objects: true }),
    validIdentity({ has_runtime_membership: false }),
    validIdentity({ has_owner_membership: true }),
    validIdentity({ can_create_any_schema_objects: true }),
    validIdentity({ owns_application_relations: true }),
    validIdentity({ login_inherits_roles: false })
  ]) {
    const pool = { async query() { return { rows: [identity] }; } };
    await assert.rejects(
      () => assertRuntimeDatabaseRole(pool),
      error => error.code === 'PERSISTENCE_RUNTIME_ROLE_INVALID'
    );
  }
});

test('runtime database preflight rejects missing login metadata and invalid pools', async () => {
  await assert.rejects(
    () => assertRuntimeDatabaseRole({ async query() { return { rows: [] }; } }),
    error => error.code === 'PERSISTENCE_RUNTIME_ROLE_INVALID'
  );
  await assert.rejects(
    () => assertRuntimeDatabaseRole({}),
    TypeError
  );
});
