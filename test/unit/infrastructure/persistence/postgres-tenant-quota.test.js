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

test('reserveWorkflow marks a newly inserted reservation as created', async () => {
  const db = { async transaction(work) { return work({ async query(sql) {
    if (sql.includes('SELECT max_concurrent,max_queued')) return { rows: [{ max_concurrent: 2, max_queued: 5 }], rowCount: 1 };
    if (sql.includes('SELECT tenant_id,workflow_id,state,reserved_at,expires_at')) return { rows: [], rowCount: 0 };
    if (sql.includes('COUNT(*) FILTER')) return { rows: [{ active: 0, queued: 0 }], rowCount: 1 };
    if (sql.includes('RETURNING tenant_id,workflow_id,state,reserved_at,expires_at')) return { rows: [{ tenant_id: 'tenant-a', workflow_id: 'wf-new', state: 'QUEUED', reserved_at: new Date().toISOString(), expires_at: null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }}); } };
  const result = await new PostgresTenantQuotaRepository(db).reserveWorkflow({ tenantId: 'tenant-a', workflowId: 'wf-new', policy: { maxConcurrent: 2, maxQueued: 5 } });
  assert.equal(result.created, true);
});

test('reserveWorkflow marks a previously existing reservation as not created', async () => {
  const db = { async transaction(work) { return work({ async query(sql) {
    if (sql.includes('SELECT max_concurrent,max_queued')) return { rows: [{ max_concurrent: 2, max_queued: 5 }], rowCount: 1 };
    if (sql.includes('SELECT tenant_id,workflow_id,state,reserved_at,expires_at')) return { rows: [{ tenant_id: 'tenant-a', workflow_id: 'wf-old', state: 'QUEUED', reserved_at: new Date().toISOString(), expires_at: null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }}); } };
  const result = await new PostgresTenantQuotaRepository(db).reserveWorkflow({ tenantId: 'tenant-a', workflowId: 'wf-old', policy: { maxConcurrent: 2, maxQueued: 5 } });
  assert.equal(result.created, false);
});

test('releaseWorkflow can condition cleanup on the reservation timestamp', async () => {
  let captured;
  const db = { async query(sql, values) { captured = { sql, values }; return { rowCount: 1, rows: [] }; } };
  const reservedAt = '2026-11-04T12:00:00.000Z';
  await new PostgresTenantQuotaRepository(db).releaseWorkflow({
    tenantId: 'tenant-a', workflowId: 'wf-a', fencingToken: 7, reservedAt
  });
  assert.match(captured.sql, /fencing_token=\$3 AND reserved_at=\$4/);
  assert.deepEqual(captured.values, ['tenant-a', 'wf-a', 7, reservedAt]);
});

test('orphan cleanup preserves reservations during the workflow persistence grace period', async () => {
  const statements = [];
  const db = {
    async transaction(work) {
      return work({ async query(sql) {
        statements.push(sql);
        if (sql.includes('SELECT max_concurrent,max_queued')) return { rows: [{ max_concurrent: 2, max_queued: 5 }], rowCount: 1 };
        if (sql.includes('SELECT tenant_id,workflow_id,state,reserved_at,expires_at')) return { rows: [], rowCount: 0 };
        if (sql.includes('COUNT(*) FILTER')) return { rows: [{ active: 0, queued: 1 }], rowCount: 1 };
        if (sql.includes('RETURNING tenant_id,workflow_id,state,reserved_at,expires_at')) return { rows: [{ tenant_id: 'tenant-a', workflow_id: 'wf-next', state: 'QUEUED', reserved_at: new Date().toISOString(), expires_at: null }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }});
    }
  };

  await new PostgresTenantQuotaRepository(db).reserveWorkflow({
    tenantId: 'tenant-a',
    workflowId: 'wf-next',
    policy: { maxConcurrent: 2, maxQueued: 5 }
  });

  const orphanCleanup = statements.find(sql => sql.includes('DELETE FROM tenant_quota_reservations r'));
  assert.ok(orphanCleanup);
  assert.match(orphanCleanup, /reserved_at <= NOW\(\) - INTERVAL '5 minutes'/);
  assert.match(orphanCleanup, /NOT EXISTS/);
});

test('reserveWorkflow rejects a workflow ID already reserved by another tenant', async () => {
  const db = {
    async transaction(work) {
      return work({ async query(sql) {
        if (sql.includes('SELECT max_concurrent,max_queued')) return { rows: [{ max_concurrent: 2, max_queued: 5 }], rowCount: 1 };
        if (sql.includes('SELECT tenant_id,workflow_id,state,reserved_at,expires_at FROM tenant_quota_reservations WHERE tenant_id=$1')) return { rows: [], rowCount: 0 };
        if (sql.includes('COUNT(*) FILTER')) return { rows: [{ active: 0, queued: 0 }], rowCount: 1 };
        if (sql.includes('RETURNING tenant_id,workflow_id,state,reserved_at,expires_at')) return { rows: [], rowCount: 0 };
        if (sql.includes('WHERE workflow_id=$1 LIMIT 1')) return { rows: [{ tenant_id: 'tenant-owner', workflow_id: 'shared-id', state: 'QUEUED', reserved_at: new Date().toISOString(), expires_at: null }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }});
    }
  };

  await assert.rejects(
    () => new PostgresTenantQuotaRepository(db).reserveWorkflow({
      tenantId: 'tenant-attacker',
      workflowId: 'shared-id',
      policy: { maxConcurrent: 2, maxQueued: 5 }
    }),
    error => error.code === 'TENANT_QUOTA_RESERVATION_TENANT_MISMATCH'
  );
});


test('reserveWorkflow fails closed when a conflicting reservation disappears before lookup', async () => {
  const db = {
    async transaction(work) {
      return work({ async query(sql) {
        if (sql.includes('SELECT max_concurrent,max_queued')) return { rows: [{ max_concurrent: 2, max_queued: 5 }], rowCount: 1 };
        if (sql.includes('SELECT tenant_id,workflow_id,state,reserved_at,expires_at FROM tenant_quota_reservations WHERE tenant_id=$1')) return { rows: [], rowCount: 0 };
        if (sql.includes('COUNT(*) FILTER')) return { rows: [{ active: 0, queued: 0 }], rowCount: 1 };
        if (sql.includes('RETURNING tenant_id,workflow_id,state,reserved_at,expires_at')) return { rows: [], rowCount: 0 };
        if (sql.includes('WHERE workflow_id=$1 LIMIT 1')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }});
    }
  };

  await assert.rejects(
    () => new PostgresTenantQuotaRepository(db).reserveWorkflow({
      tenantId: 'tenant-a',
      workflowId: 'raced-workflow',
      policy: { maxConcurrent: 2, maxQueued: 5 }
    }),
    error => error.code === 'TENANT_QUOTA_RESERVATION_RACE'
  );
});
