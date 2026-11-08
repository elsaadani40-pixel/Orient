'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { provisionPostgresRoles } = require('../../scripts/provision-postgres-roles');

const enabled = process.env.ORIENT_RUN_ROLE_PROVISIONING_INTEGRATION === '1';

test('PostgreSQL 17 provisions isolated ORIENT roles and transfers object ownership', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'orient-role-provisioning-integration-test' });
  const password = 'integration-secret-' + Date.now();
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS public.executions (execution_id TEXT PRIMARY KEY)');
    await pool.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (version INTEGER PRIMARY KEY)');
    await pool.query('CREATE SEQUENCE IF NOT EXISTS public.workflow_lease_fencing_seq');

    await provisionPostgresRoles({
      pool,
      migratorPassword: password + '-migrator',
      runtimePassword: password + '-runtime'
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
        pg_has_role(session_user, 'orient_owner', 'MEMBER') AS admin_owner_membership
    `);
    assert.equal(membership.rows[0].migrator_owner, true);
    assert.equal(membership.rows[0].runtime_group, true);
    assert.equal(membership.rows[0].runtime_owner, false);
    assert.equal(membership.rows[0].admin_owner_membership, false);

    const runtimePrivileges = await pool.query(`
      SELECT
        has_table_privilege('orient_runtime_login', 'public.executions', 'SELECT') AS can_read,
        has_table_privilege('orient_runtime_login', 'public.executions', 'INSERT') AS can_insert
    `);
    assert.equal(runtimePrivileges.rows[0].can_read, false);
    assert.equal(runtimePrivileges.rows[0].can_insert, false);
  } finally {
    // Restore test database objects before removing the temporary roles.
    const owned = await pool.query(`
      SELECT c.relname, c.relkind
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'orient_owner'
        AND c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r','S')
    `);
    for (const row of owned.rows) {
      const identifier = '"' + row.relname.replace(/"/g, '""') + '"';
      await pool.query('ALTER ' + (row.relkind === 'S' ? 'SEQUENCE' : 'TABLE') + ' public.' + identifier + ' OWNER TO CURRENT_USER');
    }
    await pool.query('DROP OWNED BY orient_runtime_login');
    await pool.query('DROP OWNED BY orient_migrator');
    await pool.query('DROP OWNED BY orient_runtime');
    await pool.query('DROP OWNED BY orient_owner');
    await pool.query('DROP ROLE IF EXISTS orient_runtime_login');
    await pool.query('DROP ROLE IF EXISTS orient_migrator');
    await pool.query('DROP ROLE IF EXISTS orient_runtime');
    await pool.query('DROP ROLE IF EXISTS orient_owner');
    await pool.end();
  }
});
