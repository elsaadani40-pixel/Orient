'use strict';

const RUNTIME_ROLE_QUERY = `
SELECT
  session_user::text AS session_user,
  current_user::text AS current_user,
  login_role.rolsuper AS login_is_superuser,
  login_role.rolbypassrls AS login_bypasses_rls,
  login_role.rolcreatedb AS login_can_create_database,
  login_role.rolcreaterole AS login_can_create_roles,
  login_role.rolreplication AS login_can_replicate,
  login_role.rolinherit AS login_inherits_roles,
  runtime_role.rolsuper AS runtime_is_superuser,
  runtime_role.rolbypassrls AS runtime_bypasses_rls,
  runtime_role.rolcreatedb AS runtime_can_create_database,
  runtime_role.rolcreaterole AS runtime_can_create_roles,
  runtime_role.rolreplication AS runtime_can_replicate,
  runtime_role.rolcanlogin AS runtime_can_login,
  pg_has_role(session_user, 'orient_runtime', 'MEMBER') AS has_runtime_membership,
  pg_has_role(session_user, 'orient_owner', 'MEMBER') AS has_owner_membership,
  COALESCE((
    SELECT bool_or(has_schema_privilege(session_user, namespace.nspname, 'CREATE'))
    FROM pg_namespace AS namespace
    WHERE namespace.nspname <> 'information_schema'
      AND left(namespace.nspname, 3) <> 'pg_'
  ), false) AS can_create_any_schema_objects,
  EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relowner = login_role.oid
      AND relation.relkind IN ('r', 'p', 'S')
      AND namespace.nspname <> 'information_schema'
      AND left(namespace.nspname, 3) <> 'pg_'
  ) AS owns_application_relations
FROM pg_roles AS login_role
LEFT JOIN pg_roles AS runtime_role ON runtime_role.rolname = 'orient_runtime'
WHERE login_role.rolname = session_user
`;

function invalidRuntimeRole(details = {}) {
  return Object.assign(
    new Error('PostgreSQL runtime connection must use the least-privilege orient_runtime_login role.'),
    { code: 'PERSISTENCE_RUNTIME_ROLE_INVALID', details }
  );
}

async function assertRuntimeDatabaseRole(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool with query(sql) is required.');
  }

  const result = await pool.query(RUNTIME_ROLE_QUERY);
  const identity = result.rows?.[0];
  if (!identity) throw invalidRuntimeRole({ reason: 'database_login_role_not_found' });

  const forbiddenFlags = [
    'login_is_superuser',
    'login_bypasses_rls',
    'login_can_create_database',
    'login_can_create_roles',
    'login_can_replicate',
    'runtime_is_superuser',
    'runtime_bypasses_rls',
    'runtime_can_create_database',
    'runtime_can_create_roles',
    'runtime_can_replicate',
    'runtime_can_login',
    'can_create_any_schema_objects',
    'owns_application_relations'
  ];
  const elevated = forbiddenFlags.filter(flag => identity[flag] === true);
  const valid = identity.session_user === 'orient_runtime_login' &&
    identity.current_user === 'orient_runtime_login' &&
    identity.login_inherits_roles === true &&
    identity.has_runtime_membership === true &&
    identity.has_owner_membership === false &&
    elevated.length === 0;

  if (!valid) {
    throw invalidRuntimeRole({
      session_user: identity.session_user,
      current_user: identity.current_user,
      elevated_flags: elevated,
      has_runtime_membership: identity.has_runtime_membership,
      has_owner_membership: identity.has_owner_membership,
      login_inherits_roles: identity.login_inherits_roles
    });
  }

  return { role: identity.session_user, leastPrivilege: true };
}

module.exports = { assertRuntimeDatabaseRole, RUNTIME_ROLE_QUERY };
