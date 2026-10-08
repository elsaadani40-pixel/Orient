const test = require('node:test');
const assert = require('node:assert/strict');
const PostgresTenantQuotaRepository = require('../../../../src/infrastructure/persistence/postgres/postgres-tenant-quota-repository');

test('tenant promotion enforces max concurrent atomically', async () => {
  const queries = [];
  const db = {
    async transaction(work) {
      return work({ async query(sql, values) {
        queries.push({ sql, values });
        if (sql.includes('SELECT max_concurrent')) return { rows: [{ max_concurrent: 1 }], rowCount: 1 };
        if (sql.includes("COUNT(*)::int AS count")) return { rows: [{ count: 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }});
    }
  };
  const repo = new PostgresTenantQuotaRepository(db);
  await assert.rejects(
    () => repo.promoteWorkflow({ tenantId: 'tenant-a', workflowId: 'wf-2' }),
    error => error.code === 'TENANT_CONCURRENT_QUOTA_EXCEEDED'
  );
  assert.ok(queries.some(q => q.sql.includes('FOR UPDATE')));
});

test('tenant promotion moves queued reservation to running when capacity exists', async () => {
  const db = {
    async transaction(work) {
      return work({ async query(sql) {
        if (sql.includes('SELECT max_concurrent')) return { rows: [{ max_concurrent: 2 }], rowCount: 1 };
        if (sql.includes("COUNT(*)::int AS count")) return { rows: [{ count: 1 }], rowCount: 1 };
        if (sql.includes('RETURNING tenant_id,workflow_id,state')) return { rows: [{ tenant_id:'tenant-a',workflow_id:'wf-2',state:'RUNNING',reserved_at:new Date().toISOString(),expires_at:null }], rowCount:1 };
        return { rows: [], rowCount: 0 };
      }});
    }
  };
  const repo = new PostgresTenantQuotaRepository(db);
  const result = await repo.promoteWorkflow({ tenantId:'tenant-a', workflowId:'wf-2' });
  assert.equal(result.state, 'RUNNING');
});

test('quota cleanup never expires running reservations', async () => {
  const queries = [];
  const db = { async transaction(work) { return work({ async query(sql) {
    queries.push(sql);
    if (sql.includes('SELECT max_concurrent')) return { rows: [{ max_concurrent: 2 }], rowCount: 1 };
    if (sql.includes("COUNT(*)::int AS count")) return { rows: [{ count: 0 }], rowCount: 1 };
    if (sql.includes('RETURNING tenant_id,workflow_id,state')) return { rows: [{ tenant_id:'tenant-a',workflow_id:'wf-1',state:'RUNNING',reserved_at:new Date().toISOString(),expires_at:new Date().toISOString() }], rowCount:1 };
    return { rows: [], rowCount: 0 };
  }}); } };
  const repo = new PostgresTenantQuotaRepository(db);
  await repo.promoteWorkflow({tenantId:'tenant-a',workflowId:'wf-1'});
  const cleanup = queries.find(sql => sql.includes('DELETE FROM tenant_quota_reservations'));
  assert.match(cleanup, /state='QUEUED'/);
});
