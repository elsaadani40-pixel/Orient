'use strict';

const MIGRATION_ROLE_QUERY = `
SELECT
  session_user::text AS session_user,
  current_user::text AS current_user,
  migrator_role.rolsuper AS is_superuser,
  migrator_role.rolbypassrls AS bypasses_rls,
  migrator_role.rolcreatedb AS can_create_database,
  migrator_role.rolcreaterole AS can_create_roles,
  migrator_role.rolreplication AS can_replicate,
  migrator_role.rolinherit AS inherits_roles,
  migrator_role.rolcanlogin AS can_login,
  pg_has_role(session_user, 'orient_owner', 'MEMBER') AS has_owner_membership,
  pg_has_role(session_user, 'orient_owner', 'SET') AS can_set_owner_role,
  pg_has_role(session_user, 'orient_runtime', 'MEMBER') AS has_runtime_membership,
  has_schema_privilege(session_user, 'public', 'CREATE') AS can_create_public_schema_objects,
  EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relowner = migrator_role.oid
      AND relation.relkind IN ('r', 'p', 'S')
      AND namespace.nspname <> 'information_schema'
      AND left(namespace.nspname, 3) <> 'pg_'
  ) AS owns_application_relations
FROM pg_roles AS migrator_role
WHERE migrator_role.rolname = session_user
`;

function invalidMigrationRole(details = {}) {
  return Object.assign(
    new Error('PostgreSQL migration connection must use the restricted orient_migrator login role.'),
    { code: 'PERSISTENCE_MIGRATION_ROLE_INVALID', details }
  );
}

async function assertMigrationDatabaseRole(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool with query(sql) is required.');
  }

  const result = await pool.query(MIGRATION_ROLE_QUERY);
  const identity = result.rows?.[0];
  if (!identity) throw invalidMigrationRole({ reason: 'database_login_role_not_found' });

  const forbiddenFlags = [
    'is_superuser',
    'bypasses_rls',
    'can_create_database',
    'can_create_roles',
    'can_replicate',
    'inherits_roles',
    'has_runtime_membership',
    'can_create_public_schema_objects',
    'owns_application_relations'
  ];
  const elevated = forbiddenFlags.filter(flag => identity[flag] === true);
  const valid = identity.session_user === 'orient_migrator' &&
    identity.current_user === 'orient_migrator' &&
    identity.can_login === true &&
    identity.has_owner_membership === true &&
    identity.can_set_owner_role === true &&
    elevated.length === 0;

  if (!valid) {
    throw invalidMigrationRole({
      session_user: identity.session_user,
      current_user: identity.current_user,
      elevated_flags: elevated,
      can_login: identity.can_login,
      has_owner_membership: identity.has_owner_membership,
      can_set_owner_role: identity.can_set_owner_role
    });
  }

  return { role: identity.session_user, targetRole: 'orient_owner', leastPrivilege: true };
}

module.exports = { assertMigrationDatabaseRole, MIGRATION_ROLE_QUERY };
