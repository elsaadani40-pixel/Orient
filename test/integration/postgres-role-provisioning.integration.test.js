'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { provisionPostgresRoles } = require('../../scripts/provision-postgres-roles');

const enabled = process.env.ORIENT_RUN_ROLE_PROVISIONING_INTEGRATION === '1';

test('PostgreSQL 17 provisions isolated ORIENT roles using a non-superuser CREATEROLE administrator', { skip: !enabled }, async () => {
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'orient-role-provisioning-test-admin' });
  const adminPassword = 'admin-secret-' + Date.now();
  let provisionerPool;
  try {
    await adminPool.query(
      "CREATE ROLE orient_provisioner LOGIN CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '" + adminPassword + "'"
    );
    await adminPool.query('GRANT CREATE ON SCHEMA public TO orient_provisioner');

    const provisionerUrl = new URL(process.env.DATABASE_URL);
    provisionerUrl.username = 'orient_provisioner';
    provisionerUrl.password = adminPassword;
    provisionerPool = new Pool({ connectionString: provisionerUrl.toString(), application_name: 'orient-role-provisioning-test' });

    await provisionerPool.query('CREATE TABLE IF NOT EXISTS public.executions (execution_id TEXT PRIMARY KEY)');
    await provisionerPool.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (version INTEGER PRIMARY KEY)');
    await provisionerPool.query('CREATE SEQUENCE IF NOT EXISTS public.workflow_lease_fencing_seq');

    await provisionPostgresRoles({
      pool: provisionerPool,
      migratorPassword: 'migrator-secret-' + Date.now(),
      runtimePassword: 'runtime-secret-' + Date.now()
    });

    const roles = await adminPool.query(`
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

    const ownership = await adminPool.query(`
      SELECT c.relname, r.rolname AS owner
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
    `, [['executions', 'schema_migrations', 'workflow_lease_fencing_seq']]);
    assert.equal(ownership.rows.length, 3);
    assert.ok(ownership.rows.every(row => row.owner === 'orient_owner'));

    const membership = await adminPool.query(`
      SELECT
        pg_has_role('orient_migrator', 'orient_owner', 'MEMBER') AS migrator_owner,
        pg_has_role('orient_runtime_login', 'orient_runtime', 'MEMBER') AS runtime_group,
        pg_has_role('orient_runtime_login', 'orient_owner', 'MEMBER') AS runtime_owner,
        pg_has_role('orient_provisioner', 'orient_owner', 'MEMBER') AS admin_owner_membership
    `);
    assert.equal(membership.rows[0].migrator_owner, true);
    assert.equal(membership.rows[0].runtime_group, true);
    assert.equal(membership.rows[0].runtime_owner, false);
    assert.equal(membership.rows[0].admin_owner_membership, false);

    const runtimePrivileges = await adminPool.query(`
      SELECT
        has_table_privilege('orient_runtime_login', 'public.executions', 'SELECT') AS can_read,
        has_table_privilege('orient_runtime_login', 'public.executions', 'INSERT') AS can_insert
    `);
    assert.equal(runtimePrivileges.rows[0].can_read, false);
    assert.equal(runtimePrivileges.rows[0].can_insert, false);
  } finally {
    if (provisionerPool) await provisionerPool.end();
    const owned = await adminPool.query(`
      SELECT c.relname, c.relkind
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'orient_owner'
        AND c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r','S')
    `);
    for (const row of owned.rows) {
      const identifier = '"' + row.relname.replace(/"/g, '""') + '"';
      await adminPool.query('ALTER ' + (row.relkind === 'S' ? 'SEQUENCE' : 'TABLE') + ' public.' + identifier + ' OWNER TO postgres');
    }
    const existingRoles = await adminPool.query(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
      [['orient_runtime_login', 'orient_migrator', 'orient_runtime', 'orient_owner', 'orient_provisioner']]
    );
    for (const row of existingRoles.rows) {
      const identifier = '"' + row.rolname.replace(/"/g, '""') + '"';
      await adminPool.query('DROP OWNED BY ' + identifier);
    }
    for (const role of ['orient_runtime_login', 'orient_migrator', 'orient_runtime', 'orient_owner', 'orient_provisioner']) {
      await adminPool.query('DROP ROLE IF EXISTS "' + role + '"');
    }
    await adminPool.end();
  }
});
