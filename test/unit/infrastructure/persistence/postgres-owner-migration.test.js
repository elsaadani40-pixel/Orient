'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MIGRATIONS } = require('../../../../src/infrastructure/persistence/postgres/postgres-database');

test('PostgreSQL owner-scope migration fails closed when legacy executions lack owner attribution', () => {
  const migration = MIGRATIONS.find(item => item.version === 14);
  assert.ok(migration, 'migration 14 must exist');

  const sql = migration.sql;
  const guard = sql.indexOf('SELECT 1 FROM public.executions WHERE owner_id IS NULL');
  const policyChange = sql.indexOf('DROP POLICY IF EXISTS orient_tenant_scope ON public.executions');

  assert.notEqual(guard, -1, 'migration must detect unassigned legacy execution rows');
  assert.notEqual(policyChange, -1, 'migration must install the owner-scoped policy');
  assert.ok(guard < policyChange, 'legacy attribution must be checked before replacing tenant-only RLS');
  assert.match(sql, /ORIENT migration 14 blocked: executions\.owner_id contains NULL rows/);
  assert.match(sql, /USING ERRCODE = '55000'/);
});
