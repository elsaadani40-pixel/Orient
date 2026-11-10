'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { provisionPostgresRoles } = require('../../scripts/provision-postgres-roles');

const enabled = process.env.ORIENT_RUN_ROLE_PROVISIONING_INTEGRATION === '1';

test('PostgreSQL 17 provisions isolated ORIENT roles and transfers owned objects', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'orient-role-provisioning-integration-test' });
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS public.executions (execution_id TEXT PRIMARY KEY)');
    await pool.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (version INTEGER PRIMARY KEY)');
    await pool.query('CREATE SEQUENCE IF NOT EXISTS public.workflow_lease_fencing_seq');

    await provisionPostgresRoles({
      pool,
      migratorPassword: 'migrator-secret-' + Date.now(),
      runtimePassword: 'runtime-secret-' + Date.now()
    });

    const roles = await pool.query(`
      SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin, rolinherit
      FROM pg_roles
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname
    `, [['orient_owner', 'orient_migrator', 'orient_runtime', 'orient_runtime_login']]);
    assert.equal(roles.rows.length, 4);
    const byName = Object.fromEntries(roles.rows.map(row => [row.rolname, row]));
    for (const name of ['orient_owner', 'orient_runtime', 'orient_migrator', 'orient_runtime_login']) {
      assert.equal(byName[name].rolsuper, false);
      assert.equal(byName[name].rolcreatedb, false);
      assert.equal(byName[name].rolcreaterole, false);
      assert.equal(byName[name].rolreplication, false);
      assert.equal(byName[name].rolbypassrls, false);
    }
    assert.equal(byName.orient_owner.rolcanlogin, false);
    assert.equal(byName.orient_runtime.rolcanlogin, false);
    assert.equal(byName.orient_migrator.rolcanlogin, true);
    assert.equal(byName.orient_runtime_login.rolcanlogin, true);
    assert.equal(byName.orient_runtime_login.rolinherit, true);
    assert.equal(byName.orient_migrator.rolinherit, false);

    const ownership = await pool.query(`
      SELECT c.relname, r.rolname AS owner
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
    `, [['executions', 'schema_migrations', 'workflow_lease_fencing_seq']]);
    assert.equal(ownership.rows.length, 3);
    assert.ok(ownership.rows.every(row => row.owner === 'orient_owner'));

    const membership = await pool.query(`
      SELECT
        pg_has_role('orient_migrator', 'orient_owner', 'MEMBER') AS migrator_owner,
        pg_has_role('orient_runtime_login', 'orient_runtime', 'MEMBER') AS runtime_group,
        pg_has_role('orient_runtime_login', 'orient_owner', 'MEMBER') AS runtime_owner,
        EXISTS (
          SELECT 1 FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
          WHERE granted.rolname = 'orient_owner' AND member.rolname = session_user
        ) AS admin_owner_membership
    `);
    assert.equal(membership.rows[0].migrator_owner, true);
    assert.equal(membership.rows[0].runtime_group, true);
    assert.equal(membership.rows[0].runtime_owner, false);
    assert.equal(membership.rows[0].admin_owner_membership, true);

    const runtimePrivileges = await pool.query(`
      SELECT
        has_table_privilege('orient_runtime_login', 'public.executions', 'SELECT') AS can_read,
        has_table_privilege('orient_runtime_login', 'public.executions', 'INSERT') AS can_insert
    `);
    assert.equal(runtimePrivileges.rows[0].can_read, false);
    assert.equal(runtimePrivileges.rows[0].can_insert, false);
  } finally {
    const owned = await pool.query(`
      SELECT c.relname, c.relkind
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = ANY(ARRAY['orient_owner','orient_provisioner'])
        AND c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r','S')
    `);
    for (const row of owned.rows) {
      const identifier = '"' + row.relname.replace(/"/g, '""') + '"';
      await pool.query('ALTER ' + (row.relkind === 'S' ? 'SEQUENCE' : 'TABLE') + ' public.' + identifier + ' OWNER TO postgres');
    }
    const existingRoles = await pool.query(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
      [['orient_runtime_login', 'orient_migrator', 'orient_runtime', 'orient_owner']]
    );
    for (const row of existingRoles.rows) {
      const identifier = '"' + row.rolname.replace(/"/g, '""') + '"';
      await pool.query('DROP OWNED BY ' + identifier);
    }
    for (const role of ['orient_runtime_login', 'orient_migrator', 'orient_runtime', 'orient_owner']) {
      await pool.query('DROP ROLE IF EXISTS "' + role + '"');
    }
    await pool.end();
  }
});

test('CREATEROLE administrator provisions successfully when it owns the existing ORIENT objects', { skip: !enabled }, async () => {
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'orient-createrole-test-admin' });
  const password = 'provisioner-secret-' + Date.now();
  let limitedPool;
  try {
    await adminPool.query(
      "CREATE ROLE orient_provisioner LOGIN CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '" + password + "'"
    );
    const databaseName = new URL(process.env.DATABASE_URL).pathname.slice(1);
    const quotedDatabaseName = '"' + databaseName.replace(/"/g, '""') + '"';
    await adminPool.query('ALTER DATABASE ' + quotedDatabaseName + ' OWNER TO orient_provisioner');
    const applicationTables = [
      'schema_migrations','executions','events','idempotency','checkpoints','execution_evidence',
      'execution_resume_leases','workflows','workflow_leases','workflow_dispatch_claims',
      'approvals','worker_nodes','tenant_quota_limits','tenant_quota_reservations',
      'owner_chat_messages','owner_work_profiles'
    ];
    const existingTables = await adminPool.query(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2::text[])',
      ['public', applicationTables]
    );
    for (const row of existingTables.rows) {
      await adminPool.query('ALTER TABLE public."' + row.tablename.replace(/"/g, '""') + '" OWNER TO orient_provisioner');
    }
    await adminPool.query('ALTER SEQUENCE public.workflow_lease_fencing_seq OWNER TO orient_provisioner');

    const limitedUrl = new URL(process.env.DATABASE_URL);
    limitedUrl.username = 'orient_provisioner';
    limitedUrl.password = password;
    limitedPool = new Pool({ connectionString: limitedUrl.toString(), application_name: 'orient-createrole-test' });

    await provisionPostgresRoles({
      pool: limitedPool,
      migratorPassword: 'migrator-secret-' + Date.now(),
      runtimePassword: 'runtime-secret-' + Date.now()
    });

    const membership = await adminPool.query(`
      SELECT
        pg_has_role('orient_migrator', 'orient_owner', 'MEMBER') AS migrator_owner,
        pg_has_role('orient_runtime_login', 'orient_runtime', 'MEMBER') AS runtime_group,
        pg_has_role('orient_runtime_login', 'orient_owner', 'MEMBER') AS runtime_owner,
        EXISTS (
          SELECT 1 FROM pg_auth_members m
          JOIN pg_roles granted ON granted.oid = m.roleid
          JOIN pg_roles member ON member.oid = m.member
          WHERE granted.rolname = 'orient_owner' AND member.rolname = 'orient_provisioner'
        ) AS provisioner_owner_membership
    `);
    assert.equal(membership.rows[0].migrator_owner, true);
    assert.equal(membership.rows[0].runtime_group, true);
    assert.equal(membership.rows[0].runtime_owner, false);
    assert.equal(membership.rows[0].provisioner_owner_membership, true);

    const ownership = await adminPool.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'orient_owner'
        AND c.relnamespace = 'public'::regnamespace
        AND c.relname = ANY($1::text[])
    `, [['executions', 'schema_migrations', 'workflow_lease_fencing_seq']]);
    assert.equal(ownership.rows[0].count, 3);
  } finally {
    if (limitedPool) await limitedPool.end();
    // This scenario intentionally leaves its role and database-owner state in
    // the disposable PostgreSQL service container. The container is destroyed
    // when the integration job completes, avoiding brittle cleanup of the
    // grantor dependency graph that the test is specifically exercising.
    await adminPool.end();
  }
});
