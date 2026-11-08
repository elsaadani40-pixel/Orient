#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

function quoteLiteral(value) {
  if (typeof value !== 'string' || value.length < 16) {
    throw new TypeError('Role passwords must be at least 16 characters.');
  }
  return "'" + value.replace(/'/g, "''") + "'";
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('A PostgreSQL identifier is required.');
  }
  return '"' + value.replace(/"/g, '""') + '"';
}

async function assertExpectedRoleMemberships(client) {
  const result = await client.query(`
    SELECT
      pg_has_role(session_user, 'orient_owner', 'MEMBER') AS admin_is_owner_member,
      pg_has_role('orient_migrator', 'orient_owner', 'MEMBER') AS migrator_is_owner_member,
      pg_has_role('orient_migrator', 'orient_runtime', 'MEMBER') AS migrator_is_runtime_member,
      pg_has_role('orient_runtime_login', 'orient_runtime', 'MEMBER') AS runtime_is_runtime_member,
      pg_has_role('orient_runtime_login', 'orient_owner', 'MEMBER') AS runtime_is_owner_member
  `);
  const identity = result.rows?.[0];
  if (!identity ||
      identity.admin_is_owner_member !== true ||
      identity.migrator_is_owner_member !== true ||
      identity.migrator_is_runtime_member !== false ||
      identity.runtime_is_runtime_member !== true ||
      identity.runtime_is_owner_member !== false) {
    throw Object.assign(
      new Error('PostgreSQL administrator cannot establish the required isolated ORIENT role memberships. The provisioning login needs explicit ADMIN OPTION for the new roles; CREATEROLE alone may be insufficient on managed PostgreSQL.'),
      { code: 'PERSISTENCE_ROLE_MEMBERSHIP_GRANT_DENIED', details: identity || {} }
    );
  }
}

async function assertApplicationObjectOwnership(client, tables) {
  const identity = await client.query(
    'SELECT rolname, rolsuper FROM pg_roles WHERE rolname = session_user'
  );
  const administrator = identity.rows?.[0];
  if (!administrator) throw new Error('PostgreSQL administrator identity could not be verified.');
  if (administrator.rolsuper) return;

  const foreignOwners = tables.rows.filter(row => row.tableowner !== administrator.rolname);
  if (foreignOwners.length > 0) {
    throw Object.assign(
      new Error('PostgreSQL provisioning login must own every existing ORIENT persistence table before ownership transfer.'),
      { code: 'PERSISTENCE_ROLE_OBJECT_OWNERSHIP_INVALID', details: { foreignOwners } }
    );
  }
}

async function ensureRole(client, name, options, password = null) {
  const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  const passwordSql = password === null ? '' : ' PASSWORD ' + quoteLiteral(password);
  const statement = found.rowCount
    ? 'ALTER ROLE ' + name + ' ' + options + passwordSql
    : 'CREATE ROLE ' + name + ' ' + options + passwordSql;
  await client.query(statement);
}

async function assertPublicSchemaOwnerAuthority(client) {
  const result = await client.query(`
    SELECT role.rolsuper AS is_superuser,
           owner_role.rolname AS schema_owner,
           pg_has_role(session_user, owner_role.rolname, 'MEMBER') AS is_schema_owner_member
    FROM pg_roles role
    JOIN pg_namespace namespace ON namespace.nspname = 'public'
    JOIN pg_roles owner_role ON owner_role.oid = namespace.nspowner
    WHERE role.rolname = session_user
  `);
  const identity = result.rows?.[0];
  if (!identity || (!identity.is_superuser && identity.is_schema_owner_member !== true)) {
    throw Object.assign(
      new Error('PostgreSQL provisioning login must own the public schema or be a member of its owning role to grant schema privileges to ORIENT roles.'),
      { code: 'PERSISTENCE_ROLE_SCHEMA_AUTHORITY_INVALID', details: identity || {} }
    );
  }
}

async function provisionPostgresRoles({ pool, migratorPassword, runtimePassword }) {
  // Validate secrets before opening a connection or beginning a transaction.
  quoteLiteral(migratorPassword);
  quoteLiteral(runtimePassword);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('An administrative PostgreSQL pool is required.');
  const client = await pool.connect();
  const applicationTables = [
    'schema_migrations','executions','events','idempotency','checkpoints','execution_evidence',
    'execution_resume_leases','workflows','workflow_leases','workflow_dispatch_claims',
    'approvals','worker_nodes','tenant_quota_limits','tenant_quota_reservations',
    'owner_chat_messages','owner_work_profiles'
  ];
  try {
    await client.query('BEGIN');
    await ensureRole(client, 'orient_owner', 'NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await ensureRole(client, 'orient_runtime', 'NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await ensureRole(client, 'orient_migrator', 'LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', migratorPassword);
    await ensureRole(client, 'orient_runtime_login', 'LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', runtimePassword);
    await client.query('GRANT orient_owner TO orient_migrator');
    // PostgreSQL requires the active administrator to be a member of the
    // destination role when transferring existing object ownership. Grant
    // this membership only for the transaction and revoke it before commit.
    await client.query('GRANT orient_owner TO CURRENT_USER');
    await client.query('GRANT orient_runtime TO orient_runtime_login');
    await assertExpectedRoleMemberships(client);
    await assertPublicSchemaOwnerAuthority(client);
    await client.query('GRANT USAGE, CREATE ON SCHEMA public TO orient_owner');
    await client.query('GRANT USAGE ON SCHEMA public TO orient_runtime');
    await client.query('REVOKE CREATE ON SCHEMA public FROM orient_runtime');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE orient_owner IN SCHEMA public REVOKE ALL ON TABLES FROM orient_runtime');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE orient_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM orient_runtime');
    const tables = await client.query(
      'SELECT tablename, tableowner FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2::text[])',
      ['public', applicationTables]
    );
    await assertApplicationObjectOwnership(client, tables);
    for (const row of tables.rows) {
      await client.query('ALTER TABLE public.' + row.tablename + ' OWNER TO orient_owner');
    }
    const sequences = await client.query(
      "SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' AND sequence_name = $1",
      ['workflow_lease_fencing_seq']
    );
    for (const row of sequences.rows) {
      await client.query('ALTER SEQUENCE public.' + row.sequence_name + ' OWNER TO orient_owner');
    }
    await client.query('REVOKE orient_owner FROM CURRENT_USER');
    await client.query('COMMIT');
    return {
      ownerRole: 'orient_owner',
      migrationLogin: 'orient_migrator',
      runtimeGroupRole: 'orient_runtime',
      runtimeLogin: 'orient_runtime_login',
      ownedTables: tables.rows.map(row => row.tablename)
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const connectionString = process.env.ORIENT_ADMIN_DATABASE_URL;
  const migratorPassword = process.env.ORIENT_MIGRATOR_PASSWORD;
  const runtimePassword = process.env.ORIENT_RUNTIME_PASSWORD;
  if (!connectionString || !migratorPassword || !runtimePassword) {
    throw new Error('ORIENT_ADMIN_DATABASE_URL, ORIENT_MIGRATOR_PASSWORD, and ORIENT_RUNTIME_PASSWORD are required.');
  }
  const pool = new Pool({ connectionString, application_name: 'orient-role-provisioning' });
  try {
    const result = await provisionPostgresRoles({ pool, migratorPassword, runtimePassword });
    process.stdout.write('Provisioned ORIENT database roles: ' + JSON.stringify(result) + '\n');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write('ORIENT PostgreSQL role provisioning failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { provisionPostgresRoles };
