const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { PostgresPersistence } = require('../../src/infrastructure/persistence/postgres/postgres-persistence');
const ApprovalService = require('../../src/core/agent/approval/approval-service');
const AuthorizationService = require('../../src/core/agent/authorization/authorization-service');
const CapabilityMapper = require('../../src/core/agent/capability/capability-mapper');
const PolicyEngine = require('../../src/core/agent/policy/policy-engine');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = new PostgresPersistence({ pool });

test('PostgreSQL initializes versioned schema idempotently on a real server', async () => {
  await persistence.initialize();
  await persistence.initialize();
  const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(result.rows.map(row => Number(row.version)), [1, 2, 3, 4, 5, 6]);
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


test('PostgreSQL resume leases are atomic, tenant-scoped, and releasable only by the owner', async () => {
  const executionId = 'resume-lease-' + Date.now();
  const tenantId = 'tenant-resume-lease';
  await persistence.checkpoints.save({
    executionId,
    tenantId,
    metadata: { tenantId },
    status: 'running'
  }, { tenantId });

  const first = await persistence.checkpoints.acquireResumeLease(executionId, {
    tenantId,
    leaseDurationMs: 30000
  });
  assert.ok(first?.leaseId);

  await assert.rejects(
    () => persistence.checkpoints.acquireResumeLease(executionId, {
      tenantId,
      leaseDurationMs: 30000
    }),
    error => error.code === 'CHECKPOINT_RESUME_LEASE_HELD'
  );

  assert.equal(
    await persistence.checkpoints.releaseResumeLease(executionId, 'not-the-owner', { tenantId }),
    false
  );

  await pool.query(
    "UPDATE execution_resume_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE execution_id=$1 AND tenant_id=$2",
    [executionId, tenantId]
  );
  const second = await persistence.checkpoints.acquireResumeLease(executionId, {
    tenantId,
    leaseDurationMs: 30000
  });
  assert.ok(second?.leaseId);
  assert.notEqual(second.leaseId, first.leaseId);

  const renewed = await persistence.checkpoints.renewResumeLease(executionId, second.leaseId, {
    tenantId,
    leaseDurationMs: 60000
  });
  assert.ok(renewed?.expiresAtMs > second.expiresAtMs);
  assert.equal(await persistence.checkpoints.renewResumeLease(executionId, first.leaseId, {
    tenantId,
    leaseDurationMs: 30000
  }), null);

  assert.equal(
    await persistence.checkpoints.releaseResumeLease(executionId, first.leaseId, { tenantId }),
    false
  );
  assert.equal(
    await persistence.checkpoints.releaseResumeLease(executionId, second.leaseId, { tenantId }),
    true
  );
  await pool.query('DELETE FROM checkpoints WHERE execution_id=$1 AND tenant_id=$2', [executionId, tenantId]);
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

  await persistence.workers.register({ workerId: 'worker', tenantId: 'tenant-recovery', status: 'READY', capabilities: [], heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, 'tenant-recovery');
  await persistence.workers.register({ workerId: 'recovery-worker', tenantId: 'tenant-recovery', status: 'READY', capabilities: [], heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, 'tenant-recovery');

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
  await persistence.workers.unregister('worker', 'tenant-recovery');
  await persistence.workers.unregister('recovery-worker', 'tenant-recovery');
  await pool.query('DELETE FROM workflow_leases WHERE workflow_id=$1', [workflowId]);
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});


test('PostgreSQL rejects a stale worker that resumes after takeover during step execution', async () => {
  const WorkflowDefinition = require('../../src/core/workflow/workflow-definition');
  const WorkflowInstance = require('../../src/core/workflow/workflow-instance');
  const AsyncWorkflowScheduler = require('../../src/core/workflow/async-workflow-scheduler');
  const AsyncWorkflowWorker = require('../../src/core/workflow/async-workflow-worker');

  const workflowId = 'stale-worker-wf-' + Date.now();
  const tenantId = 'tenant-stale-worker';
  const definition = new WorkflowDefinition({
    id: 'stale-worker-definition',
    version: 1,
    name: 'Stale Worker',
    steps: [{ id: 'protected-step', tool: 'noop', input: {} }]
  });
  const instance = new WorkflowInstance({ definition, workflowId, tenantId });
  instance.transition('QUEUED');
  await persistence.workflows.save(instance, tenantId);

  const schedulerA = new AsyncWorkflowScheduler({
    workflowRepository: persistence.workflows,
    leaseRepository: persistence.workflowLeases,
    tenantId,
    leaseDurationMs: 1000
  });
  const schedulerB = new AsyncWorkflowScheduler({
    workflowRepository: persistence.workflows,
    leaseRepository: persistence.workflowLeases,
    tenantId,
    leaseDurationMs: 30000
  });

  await persistence.workers.register({ workerId: 'stale-worker-a', tenantId, status: 'READY', capabilities: [], heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, tenantId);
  await persistence.workers.register({ workerId: 'worker', tenantId, status: 'READY', capabilities: [], heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, tenantId);
  await persistence.workers.register({ workerId: 'recovery-worker-b', tenantId, status: 'READY', capabilities: [], heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, tenantId);

  await schedulerA.enqueueDurable(instance);

  let takeover = null;
  let allowInitialRenew = true;
  const workerA = new AsyncWorkflowWorker({
    scheduler: schedulerA,
    workerId: 'stale-worker-a',
    executor: async () => {
      await pool.query(
        "UPDATE workflow_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
        [workflowId]
      );
      const recovered = await schedulerB.recoverPersisted();
      assert.equal(recovered, 1);

      const workerB = new AsyncWorkflowWorker({
        scheduler: schedulerB,
        workerId: 'recovery-worker-b',
        executor: async ({ instance: recoveredInstance }) => {
          return { committedBy: 'worker-b', workflowId: recoveredInstance.workflowId };
        }
      });

      takeover = await workerB.tick();
      assert.ok(takeover);
      assert.equal(takeover.state, 'COMPLETED');
      return { committedBy: 'worker-a', workflowId };
    }
  });

  const originalRenewA = schedulerA.renewAsync.bind(schedulerA);
  schedulerA.renewAsync = async (...args) => {
    if (args[0] === workflowId && allowInitialRenew) {
      allowInitialRenew = false;
      return originalRenewA(...args);
    }
    if (args[0] === workflowId) {
      const error = new Error('simulated lost lease');
      error.code = 'WORKFLOW_LEASE_NOT_OWNER';
      throw error;
    }
    return originalRenewA(...args);
  };

  const staleResult = await workerA.tick();
  assert.equal(staleResult, null);
  assert.ok(takeover);
  assert.equal(takeover.metadata.fencingToken > 0, true);

  const persisted = await persistence.workflows.findById(workflowId, tenantId);
  assert.equal(persisted.state, 'COMPLETED');
  assert.equal(persisted.metadata.fencingToken, takeover.metadata.fencingToken);
  assert.equal(persisted.steps['protected-step'].state, 'COMPLETED');
  assert.equal(persisted.steps['protected-step'].result.committedBy, 'worker-b');

  await pool.query('DELETE FROM workflow_leases WHERE workflow_id=$1', [workflowId]);
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});



test('PostgreSQL quota survives stale worker release after lease takeover', async () => {
  const WorkflowDefinition = require('../../src/core/workflow/workflow-definition');
  const WorkflowInstance = require('../../src/core/workflow/workflow-instance');
  const AsyncWorkflowScheduler = require('../../src/core/workflow/async-workflow-scheduler');

  const workflowId = 'quota-takeover-wf-' + Date.now();
  const tenantId = 'tenant-quota-takeover';
  const policy = { maxConcurrent: 1, maxQueued: 2, maxInputChars: 1000, maxToolInputChars: 1000, maxRetries: 2 };
  const definition = new WorkflowDefinition({
    id: 'quota-takeover-definition',
    version: 1,
    name: 'Quota Takeover',
    steps: [{ id: 'step', tool: 'noop', input: {} }]
  });
  const instance = new WorkflowInstance({ definition, workflowId, tenantId });
  instance.transition('QUEUED');
  await persistence.workflows.save(instance, tenantId);
  await persistence.tenantQuotas.ensureTenant(tenantId, policy);

  await persistence.workers.register({ workerId: 'worker', tenantId, status: 'READY', capabilities: [], heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, tenantId);

  const schedulerA = new AsyncWorkflowScheduler({
    workflowRepository: persistence.workflows,
    leaseRepository: persistence.workflowLeases,
    quotaRepository: persistence.tenantQuotas,
    quotaPolicy: policy,
    tenantId,
    leaseDurationMs: 30000
  });
  const schedulerB = new AsyncWorkflowScheduler({
    workflowRepository: persistence.workflows,
    leaseRepository: persistence.workflowLeases,
    quotaRepository: persistence.tenantQuotas,
    quotaPolicy: policy,
    tenantId,
    leaseDurationMs: 30000
  });

  await schedulerA.enqueueDurable(instance);
  const leaseA = await schedulerA.leaseAsync('quota-worker-a');
  assert.ok(leaseA);

  const beforeTakeover = await persistence.tenantQuotas.snapshot({ tenantId });
  assert.deepEqual(beforeTakeover, { tenantId, active: 1, queued: 0 });

  await pool.query(
    "UPDATE workflow_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
    [workflowId]
  );
  await pool.query(
    "UPDATE tenant_quota_reservations SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1 AND tenant_id=$2",
    [workflowId, tenantId]
  );

  const recovered = await schedulerB.recoverPersisted();
  assert.equal(recovered, 1);
  const leaseB = await schedulerB.leaseAsync('quota-worker-b');
  assert.ok(leaseB);
  assert.ok(leaseB.fencingToken > leaseA.fencingToken);

  const afterTakeover = await persistence.tenantQuotas.snapshot({ tenantId });
  assert.deepEqual(afterTakeover, { tenantId, active: 1, queued: 0 });

  const staleRelease = await schedulerA.releaseAsync(workflowId, leaseA.leaseId);
  assert.equal(staleRelease, false);

  const afterStaleRelease = await persistence.tenantQuotas.snapshot({ tenantId });
  assert.deepEqual(afterStaleRelease, { tenantId, active: 1, queued: 0 });

  const currentRelease = await schedulerB.releaseAsync(workflowId, leaseB.leaseId);
  assert.equal(currentRelease, true);
  const finalSnapshot = await persistence.tenantQuotas.snapshot({ tenantId });
  assert.deepEqual(finalSnapshot, { tenantId, active: 0, queued: 0 });

  await pool.query('DELETE FROM workflow_leases WHERE workflow_id=$1', [workflowId]);
  await pool.query('DELETE FROM tenant_quota_reservations WHERE workflow_id=$1', [workflowId]);
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
  await pool.query('DELETE FROM tenant_quota_limits WHERE tenant_id=$1', [tenantId]);
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

test('PostgreSQL workflow repository resolves approval-blocked executions by tenant', async () => {
  const WorkflowDefinition = require('../../src/core/workflow/workflow-definition');
  const WorkflowInstance = require('../../src/core/workflow/workflow-instance');
  const workflowId = 'approval-workflow-map-' + Date.now();
  const executionId = 'approval-execution-map-' + Date.now();
  const tenantId = 'tenant-approval-map';
  const definition = new WorkflowDefinition({
    id: 'approval-mapping',
    version: 1,
    name: 'Approval mapping',
    steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME' }]
  });
  const instance = new WorkflowInstance({
    definition,
    workflowId,
    tenantId,
    input: { text: 'guarded operation' }
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  instance.transition('WAITING');
  instance.metadata = { approvalBlocked: true, approvalExecutionId: executionId, approvalId: 'approval-map' };
  await persistence.workflows.save(instance, tenantId);

  try {
    const found = await persistence.workflows.findByApprovalExecutionId({ executionId, tenantId });
    assert.equal(found.workflowId, workflowId);
    assert.equal(found.metadata.approvalId, 'approval-map');
    assert.equal(await persistence.workflows.findByApprovalExecutionId({ executionId, tenantId: 'tenant-other' }), null);
  } finally {
    await persistence.workflows.delete(workflowId, tenantId);
  }
});

test('PostgreSQL approval authorization is durable, tenant-scoped and replay-safe', async () => {
  const mapper = new CapabilityMapper({
    mappings: { 'danger.write': 'external.write' }
  });
  const policy = new PolicyEngine({
    capabilities: ['external.write'],
    riskByCapability: { 'external.write': 'high' }
  });
  const approvals = new ApprovalService({
    repository: persistence.approvals,
    tenantId: 'tenant-approval-service',
    decisionAuthorizer: async () => true
  });
  const auth = new AuthorizationService({
    capabilityMapper: mapper,
    capabilityPolicy: policy,
    approvalService: approvals
  });

  const approval = await approvals.issue({
    executionId: 'exec-approval-service',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { planRevision: 1 },
    tenantId: 'tenant-approval-service'
  });

  await approvals.decide({ approvalId: approval.approvalId, executionId: 'exec-approval-service', decision: 'approved', actorId: 'owner-test', tenantId: 'tenant-approval-service' });

  const allowed = await auth.authorize('danger.write', {
    executionId: 'exec-approval-service',
    step: 1,
    planRevision: 1,
    approval,
    scope: { planRevision: 1 },
    tenantId: 'tenant-approval-service'
  });
  assert.equal(allowed.allowed, true);

  const consumed = await approvals.consume(
    approval.approvalId,
    'tenant-approval-service'
  );
  assert.equal(consumed, true);

  const replay = await auth.authorize('danger.write', {
    executionId: 'exec-approval-service',
    step: 1,
    planRevision: 1,
    approval,
    scope: { planRevision: 1 },
    tenantId: 'tenant-approval-service'
  });
  assert.equal(replay.allowed, false);
  assert.equal(replay.reason, 'APPROVAL_ALREADY_USED');

  const crossTenant = await auth.authorize('danger.write', {
    executionId: 'exec-approval-service',
    step: 1,
    planRevision: 1,
    approval,
    scope: { planRevision: 1 },
    tenantId: 'tenant-other'
  });
  assert.equal(crossTenant.allowed, false);
  assert.equal(crossTenant.reason, 'APPROVAL_NOT_FOUND');

  await pool.query(
    'DELETE FROM approvals WHERE approval_id=$1 AND tenant_id=$2',
    [approval.approvalId, 'tenant-approval-service']
  );
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

test('PostgreSQL worker lease cannot resurrect a durably cancelled workflow', async () => {
  const workflowId = 'cancel-lease-' + Date.now();
  await pool.query(
    "INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,'tenant-cancel','CANCELLED',NOW(),$2)",
    [workflowId, { workflowId, tenantId: 'tenant-cancel', state: 'CANCELLED', cancelRequested: true, metadata: {} }]
  );

  await assert.rejects(
    () => persistence.workflowLeases.tryAcquire({
      workflowId,
      leaseId: 'cancel-lease-' + Date.now(),
      workerId: 'worker-cancel',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30000,
      metadata: { tenantId: 'tenant-cancel' }
    }, 'tenant-cancel'),
    error => error.code === 'WORKFLOW_CANCELLATION_REQUESTED'
  );

  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});

test('PostgreSQL durable claims require a live registered worker identity', async () => {
  const workflowId = 'worker-auth-' + Date.now();
  await pool.query(
    "INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,'tenant-worker-auth','QUEUED',NOW(),$2)",
    [workflowId, { workflowId, tenantId: 'tenant-worker-auth', state: 'QUEUED', metadata: {} }]
  );

  await assert.rejects(
    () => persistence.workflows.claimQueued({
      tenantId: 'tenant-worker-auth',
      workerId: 'unregistered-worker',
      limit: 1
    }),
    error => error.code === 'WORKER_NOT_ACTIVE'
  );

  await persistence.workers.register({
    workerId: 'registered-worker',
    tenantId: 'tenant-worker-auth',
    status: 'READY',
    capabilities: ['research.read'],
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  }, 'tenant-worker-auth');

  const claimed = await persistence.workflows.claimQueued({
    tenantId: 'tenant-worker-auth',
    workerId: 'registered-worker',
    workerCapabilities: ['research.read'],
    limit: 1
  });
  assert.equal(claimed.length, 1);

  await persistence.workflows.releaseDispatchClaim(workflowId, 'registered-worker', 'tenant-worker-auth');
  await persistence.workers.unregister('registered-worker', 'tenant-worker-auth');
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});

test('PostgreSQL dispatch claims are exclusive across concurrent workers and expire safely', async () => {
  const workflowId = 'claim-wf-' + Date.now();
  await pool.query(
    "INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,'tenant-claim','QUEUED',NOW(),$2)",
    [workflowId, { workflowId, tenantId: 'tenant-claim', state: 'QUEUED', metadata: {} }]
  );

  const workers = ['worker-a', 'worker-b', 'worker-recovery'].map(id => id + '-' + Date.now());
  for (const workerId of workers) {
    await persistence.workers.register({
      workerId,
      tenantId: 'tenant-claim',
      status: 'READY',
      capabilities: [],
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    }, 'tenant-claim');
  }
  const [workerA, workerB] = workers;

  const [a, b] = await Promise.all([
    persistence.workflows.claimQueued({
      tenantId: 'tenant-claim',
      workerId: workerA,
      limit: 1,
      claimTtlMs: 60000
    }),
    persistence.workflows.claimQueued({
      tenantId: 'tenant-claim',
      workerId: workerB,
      limit: 1,
      claimTtlMs: 60000
    })
  ]);

  assert.equal(a.length + b.length, 1);

  await pool.query(
    "UPDATE workflow_dispatch_claims SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
    [workflowId]
  );

  const workerRecovery = workers[2];

  const recovered = await persistence.workflows.claimQueued({
    tenantId: 'tenant-claim',
    workerId: workerRecovery,
    limit: 1,
    claimTtlMs: 60000
  });
  assert.equal(recovered.length, 1);

  await persistence.workflows.releaseDispatchClaim(workflowId, workerRecovery, 'tenant-claim');
  for (const workerId of workers) await persistence.workers.unregister(workerId, 'tenant-claim');
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});


test('PostgreSQL execution cancellation is durable and tenant-scoped', async () => {
  const executionId = 'cancel-exec-' + Date.now();
  await persistence.executions.insert({
    executionId,
    requestId: 'cancel-request',
    status: 'running',
    metadata: { tenantId: 'tenant-cancel' }
  }, { tenantId: 'tenant-cancel' });

  const requested = await persistence.executions.requestCancellation(
    executionId,
    'stop requested',
    { tenantId: 'tenant-cancel' }
  );

  assert.equal(requested.cancellationRequested, true);
  assert.equal(requested.cancellationReason, 'stop requested');

  const persisted = await persistence.executions.findById(executionId, {
    tenantId: 'tenant-cancel'
  });
  assert.equal(persisted.cancellationRequested, true);

  const crossTenant = await persistence.executions.requestCancellation(
    executionId,
    'cross tenant',
    { tenantId: 'tenant-other' }
  );
  assert.equal(crossTenant, null);

  await persistence.executions.deleteById(executionId, {
    tenantId: 'tenant-cancel'
  });
});


test('PostgreSQL cancellation wins terminal completion race', async () => {
  const executionId = 'outcome-race-' + Date.now();
  await persistence.executions.insert({
    executionId,
    requestId: 'outcome-race-request',
    status: 'running',
    metadata: { tenantId: 'tenant-outcome' },
    result: null
  }, { tenantId: 'tenant-outcome' });

  await persistence.executions.requestCancellation(
    executionId,
    'stop before commit',
    { tenantId: 'tenant-outcome' }
  );

  const attemptedCompletion = await persistence.executions.update(
    executionId,
    {
      status: 'completed',
      result: { value: 'must-not-win' },
      completedAt: new Date().toISOString()
    },
    { tenantId: 'tenant-outcome' }
  );

  assert.equal(attemptedCompletion.status, 'running');
  assert.equal(attemptedCompletion.cancellationRequested, true);
  assert.equal(attemptedCompletion.result, null);

  const attemptedFailure = await persistence.executions.update(
    executionId,
    {
      status: 'failed',
      error: { code: 'TOOL_FAILED' },
      completedAt: new Date().toISOString()
    },
    { tenantId: 'tenant-outcome' }
  );

  assert.equal(attemptedFailure.status, 'running');
  assert.equal(attemptedFailure.cancellationRequested, true);
  assert.equal(attemptedFailure.result, null);

  await persistence.executions.deleteById(executionId, {
    tenantId: 'tenant-outcome'
  });
});
