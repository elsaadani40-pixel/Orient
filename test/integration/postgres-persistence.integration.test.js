const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { PostgresPersistence } = require('../../src/infrastructure/persistence/postgres/postgres-persistence');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = new PostgresPersistence({ pool });

test('PostgreSQL initializes versioned schema idempotently on a real server', async () => {
  await persistence.initialize();
  await persistence.initialize();
  const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(result.rows.map(row => Number(row.version)), [1, 2]);
});

test('PostgreSQL idempotency keys are tenant-scoped on a real server', async () => {
  const a = await persistence.idempotency.begin({ executionId: 'exec-a', step: 1, tool: 'memory.read', tenantId: 'tenant-a' });
  const b = await persistence.idempotency.begin({ executionId: 'exec-a', step: 1, tool: 'memory.read', tenantId: 'tenant-b' });
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.equal(a.record.tenantId, 'tenant-a');
  assert.equal(b.record.tenantId, 'tenant-b');
});

test('PostgreSQL checkpoints preserve ordered history on a real server', async () => {
  const first = await persistence.checkpoints.save({ executionId: 'exec-checkpoint', tenantId: 'tenant-a', step: 1 }, { tenantId: 'tenant-a' });
  const second = await persistence.checkpoints.save({ executionId: 'exec-checkpoint', tenantId: 'tenant-a', step: 2 }, { tenantId: 'tenant-a' });
  const latest = await persistence.checkpoints.findLatest('exec-checkpoint', { tenantId: 'tenant-a' });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(latest.sequence, 2);
  assert.equal(latest.snapshot.step, 2);
});


test('PostgreSQL fencing rejects stale writes after a lease takeover', async () => {
  const workflowId = 'fence-wf-' + Date.now();
  await pool.query(
    "INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,'tenant-fence','RUNNING',NOW(),$2)",
    [workflowId, { workflowId, tenantId: 'tenant-fence', state: 'RUNNING', metadata: {} }]
  );

  const first = await persistence.workflowLeases.tryAcquire({
    workflowId,
    leaseId: 'lease-a-' + Date.now(),
    workerId: 'worker-a',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-fence' }
  }, 'tenant-fence');

  assert.ok(first.fencingToken > 0);

  await persistence.workflows.save({
    workflowId,
    tenantId: 'tenant-fence',
    state: 'RUNNING',
    metadata: { fencingToken: first.fencingToken },
    toJSON() { return this; }
  }, 'tenant-fence');

  await pool.query(
    "UPDATE workflow_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
    [workflowId]
  );

  const second = await persistence.workflowLeases.tryAcquire({
    workflowId,
    leaseId: 'lease-b-' + Date.now(),
    workerId: 'worker-b',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-fence' }
  }, 'tenant-fence');

  assert.ok(second.fencingToken > first.fencingToken);

  await assert.rejects(
    () => persistence.workflows.save({
      workflowId,
      tenantId: 'tenant-fence',
      state: 'RUNNING',
      metadata: { fencingToken: first.fencingToken },
      toJSON() { return this; }
    }, 'tenant-fence'),
    error => error.code === 'WORKFLOW_FENCING_REJECTED'
  );

  await persistence.workflows.save({
    workflowId,
    tenantId: 'tenant-fence',
    state: 'RUNNING',
    metadata: { fencingToken: second.fencingToken },
    toJSON() { return this; }
  }, 'tenant-fence');

  await persistence.workflowLeases.delete(workflowId, second.leaseId, 'tenant-fence');
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});


test('PostgreSQL rejects stale lease renewal after takeover', async () => {
  const workflowId = 'renew-fence-wf-' + Date.now();
  await pool.query(
    "INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,'tenant-renew','RUNNING',NOW(),$2)",
    [workflowId, { workflowId, tenantId: 'tenant-renew', state: 'RUNNING', metadata: {} }]
  );

  const first = await persistence.workflowLeases.tryAcquire({
    workflowId,
    leaseId: 'renew-lease-a-' + Date.now(),
    workerId: 'renew-worker-a',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-renew' }
  }, 'tenant-renew');

  await pool.query(
    "UPDATE workflow_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
    [workflowId]
  );

  const second = await persistence.workflowLeases.tryAcquire({
    workflowId,
    leaseId: 'renew-lease-b-' + Date.now(),
    workerId: 'renew-worker-b',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-renew' }
  }, 'tenant-renew');

  assert.ok(second.fencingToken > first.fencingToken);
  assert.equal(
    await persistence.workflowLeases.renewIfOwned(
      workflowId,
      first.leaseId,
      Date.now() + 60000,
      Date.now(),
      'tenant-renew'
    ),
    false
  );
  assert.equal(
    await persistence.workflowLeases.renewIfOwned(
      workflowId,
      second.leaseId,
      Date.now() + 60000,
      Date.now(),
      'tenant-renew'
    ),
    true
  );

  await persistence.workflowLeases.delete(workflowId, second.leaseId, 'tenant-renew');
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});


test('PostgreSQL crash recovery requeues an orphaned running workflow after lease expiry', async () => {
  const WorkflowDefinition = require('../../src/core/workflow/workflow-definition');
  const WorkflowInstance = require('../../src/core/workflow/workflow-instance');
  const AsyncWorkflowScheduler = require('../../src/core/workflow/async-workflow-scheduler');

  const workflowId = 'crash-recovery-wf-' + Date.now();
  const definition = new WorkflowDefinition({
    id: 'crash-recovery-definition',
    version: 1,
    name: 'Crash Recovery',
    steps: [{ id: 'resume-step', tool: 'noop', input: {} }]
  });
  const instance = new WorkflowInstance({
    definition,
    workflowId,
    tenantId: 'tenant-recovery'
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  await persistence.workflows.save(instance, 'tenant-recovery');

  const firstLease = await persistence.workflowLeases.tryAcquire({
    workflowId,
    leaseId: 'crash-lease-a-' + Date.now(),
    workerId: 'crashed-worker',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-recovery' }
  }, 'tenant-recovery');

  await pool.query(
    "UPDATE workflow_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
    [workflowId]
  );

  const scheduler = new AsyncWorkflowScheduler({
    workflowRepository: persistence.workflows,
    leaseRepository: persistence.workflowLeases,
    tenantId: 'tenant-recovery',
    leaseDurationMs: 30000
  });

  const persistedLease = await persistence.workflowLeases.findByWorkflowId(workflowId, 'tenant-recovery');
  assert.ok(persistedLease.expiresAt <= Date.now());

  const recovered = await scheduler.recoverPersisted();
  assert.equal(recovered, 1);
  assert.equal(scheduler.queue.length, 1);
  assert.equal(scheduler.queue[0].instance.state, 'QUEUED');

  const takeover = await scheduler.leaseAsync('recovery-worker');
  assert.ok(takeover);
  assert.equal(takeover.workflowId, workflowId);
  assert.ok(takeover.fencingToken > firstLease.fencingToken);
  assert.equal(takeover.instance.state, 'RUNNING');

  await scheduler.releaseAsync(workflowId, takeover.leaseId);
  await pool.query('DELETE FROM workflow_leases WHERE workflow_id=$1', [workflowId]);
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});

test('PostgreSQL approval consumption is single-use under concurrency', async () => {
  const approvalId = 'approval-' + Date.now();
  await persistence.approvals.save({
    approvalId,
    tenantId: 'tenant-approval',
    executionId: 'exec-approval',
    step: 1,
    planRevision: 1,
    tool: 'external.write',
    capability: 'external.write',
    scope: { tenant: 'tenant-approval' },
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    used: false,
    metadata: { tenantId: 'tenant-approval' }
  }, { tenantId: 'tenant-approval' });
  const results = await Promise.all([
    persistence.approvals.consume(approvalId, new Date().toISOString(), 'tenant-approval'),
    persistence.approvals.consume(approvalId, new Date().toISOString(), 'tenant-approval')
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  await pool.query('DELETE FROM approvals WHERE approval_id=$1 AND tenant_id=$2', [approvalId, 'tenant-approval']);
});

test('PostgreSQL quota admission is atomic across concurrent reservations', async () => {
  await pool.query("INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ('quota-wf-a','tenant-quota','QUEUED',NOW(),'{}'), ('quota-wf-b','tenant-quota','QUEUED',NOW(),'{}')");
  const policy = { maxConcurrent: 1, maxQueued: 1, maxInputChars: 1000, maxToolInputChars: 1000, maxRetries: 2 };
  await persistence.tenantQuotas.ensureTenant('tenant-quota', policy);
  const results = await Promise.allSettled([
    persistence.tenantQuotas.reserveWorkflow({ tenantId: 'tenant-quota', workflowId: 'quota-wf-a', policy }),
    persistence.tenantQuotas.reserveWorkflow({ tenantId: 'tenant-quota', workflowId: 'quota-wf-b', policy })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected')[0].reason.code, 'TENANT_QUEUE_QUOTA_EXCEEDED');
  const winner = results.find(result => result.status === 'fulfilled').value;
  const promoted = await persistence.tenantQuotas.promoteWorkflow({ tenantId: 'tenant-quota', workflowId: winner.workflowId, expiresAt: new Date(Date.now() + 30000).toISOString() });
  assert.equal(promoted.state, 'RUNNING');
  const snapshot = await persistence.tenantQuotas.snapshot({ tenantId: 'tenant-quota' });
  assert.deepEqual(snapshot, { tenantId: 'tenant-quota', active: 1, queued: 0 });
  await persistence.tenantQuotas.releaseWorkflow({ tenantId: 'tenant-quota', workflowId: winner.workflowId });
});

test.after(async () => { await pool.end(); });