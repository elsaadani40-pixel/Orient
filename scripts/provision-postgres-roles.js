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

async function normalizeManagedRoleMemberships(client) {
  const managedRoles = ['orient_owner', 'orient_migrator', 'orient_runtime', 'orient_runtime_login'];
  const memberships = await client.query(
    'SELECT granted.rolname AS granted_role, member.rolname AS member_role, ' +
    'grantor.rolname AS grantor_role, grantor.rolsuper AS grantor_is_superuser, ' +
    'membership.admin_option ' +
    'FROM pg_auth_members membership ' +
    'JOIN pg_roles granted ON granted.oid = membership.roleid ' +
    'JOIN pg_roles member ON member.oid = membership.member ' +
    'JOIN pg_roles grantor ON grantor.oid = membership.grantor ' +
    'WHERE granted.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[]) ' +
    'OR grantor.rolname = ANY($1::text[])',
    [managedRoles]
  );

  const rows = memberships.rows;
  const keyOf = row => JSON.stringify([row.granted_role, row.member_role, row.grantor_role]);
  const byKey = new Map(rows.map(row => [keyOf(row), row]));
  const outgoing = new Map(rows.map(row => [keyOf(row), new Set()]));
  const indegree = new Map(rows.map(row => [keyOf(row), 0]));

  // A grantor's ADMIN OPTION membership must remain until every membership
  // it granted in that role has been revoked. Build those dependencies first.
  for (const membership of rows) {
    if (membership.grantor_is_superuser) continue;
    const dependentKey = keyOf(membership);
    for (const grantorAdminMembership of rows) {
      if (
        grantorAdminMembership.granted_role === membership.granted_role &&
        grantorAdminMembership.member_role === membership.grantor_role &&
        grantorAdminMembership.admin_option
      ) {
        const sourceKey = keyOf(grantorAdminMembership);
        if (sourceKey !== dependentKey && !outgoing.get(dependentKey).has(sourceKey)) {
          outgoing.get(dependentKey).add(sourceKey);
          indegree.set(sourceKey, indegree.get(sourceKey) + 1);
        }
      }
    }
  }

  const ready = rows.filter(row => indegree.get(keyOf(row)) === 0);
  const ordered = [];
  while (ready.length > 0) {
    const membership = ready.shift();
    const key = keyOf(membership);
    ordered.push(membership);
    for (const dependentKey of outgoing.get(key)) {
      const next = indegree.get(dependentKey) - 1;
      indegree.set(dependentKey, next);
      if (next === 0) ready.push(byKey.get(dependentKey));
    }
  }
  if (ordered.length !== rows.length) {
    throw new Error('Managed PostgreSQL role memberships contain an unresolvable grant dependency cycle.');
  }

  for (const membership of ordered) {
    await client.query('SET LOCAL ROLE ' + quoteIdentifier(membership.grantor_role));
    await client.query(
      'REVOKE ' + quoteIdentifier(membership.granted_role) +
      ' FROM ' + quoteIdentifier(membership.member_role)
    );
    await client.query('RESET ROLE');
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

async function provisionPostgresRoles({ pool, migratorPassword, runtimePassword }) {
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
    await normalizeManagedRoleMemberships(client);
    await client.query('GRANT orient_owner TO orient_migrator');
    await client.query('GRANT orient_runtime TO orient_runtime_login');
    await client.query('GRANT USAGE, CREATE ON SCHEMA public TO orient_owner');
    await client.query('GRANT USAGE ON SCHEMA public TO orient_runtime');
    await client.query('REVOKE CREATE ON SCHEMA public FROM orient_runtime');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE orient_owner IN SCHEMA public REVOKE ALL ON TABLES FROM orient_runtime');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE orient_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM orient_runtime');
    const tables = await client.query(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2::text[])',
      ['public', applicationTables]
    );
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
