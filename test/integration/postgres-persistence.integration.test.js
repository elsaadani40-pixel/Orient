const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');
const { provisionPostgresRoles } = require('../../scripts/provision-postgres-roles');
const { PostgresPersistence, PostgresOwnerChatConversationRepository, PostgresOwnerWorkProfileRepository } = require('../../src/infrastructure/persistence/postgres/postgres-persistence');
const ApprovalService = require('../../src/core/agent/approval/approval-service');
const ExecutionContext = require('../../src/core/execution/execution-context');
const AuthorizationService = require('../../src/core/agent/authorization/authorization-service');
const CapabilityMapper = require('../../src/core/agent/capability/capability-mapper');
const PolicyEngine = require('../../src/core/agent/policy/policy-engine');
const createServer = require('../../src/interfaces/http/server');
const {
  Ed25519IdentityTokenIssuer,
  Ed25519IdentityTokenVerifier
} = require('../../src/infrastructure/gateway/identity/ed25519-identity-token');
const { OwnerSessionIdentityAuthority } = require('../../src/infrastructure/gateway/identity/owner-session-identity-authority');
const { GatewayIdentityExecutionService } = require('../../src/infrastructure/gateway/identity/gateway-identity-execution-service');
const { GATEWAY_OPERATION_SCOPES, createGatewayOperationHandlers } = require('../../src/infrastructure/gateway/identity/gateway-operation-handlers');
const { createGatewayIdentityRoutes } = require('../../src/interfaces/http/routes/gateway-identity.routes');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = new PostgresPersistence({ pool });

test('PostgreSQL initializes versioned schema idempotently on a real server', async () => {
  const readiness = await pool.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ready");
  if (!readiness.rows[0].ready) {
    await provisionPostgresRoles({
      pool,
      migratorPassword: crypto.randomBytes(24).toString('hex'),
      runtimePassword: crypto.randomBytes(24).toString('hex')
    });
    await persistence.migrate({ role: 'orient_owner' });
  } else {
    const current = await pool.query('SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations');
    if (Number(current.rows[0].version) < 12) {
      await provisionPostgresRoles({
        pool,
        migratorPassword: crypto.randomBytes(24).toString('hex'),
        runtimePassword: crypto.randomBytes(24).toString('hex')
      });
      await persistence.migrate({ role: 'orient_owner' });
    }
  }
  await persistence.initialize();
  await persistence.initialize();
  const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(result.rows.map(row => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('PostgreSQL runtime login preflight validates a real least-privilege connection and pooled role reset', async () => {
  const runtimePassword = crypto.randomBytes(24).toString('hex');
  await provisionPostgresRoles({
    pool,
    migratorPassword: crypto.randomBytes(24).toString('hex'),
    runtimePassword
  });

  const runtimeUrl = new URL(process.env.DATABASE_URL);
  runtimeUrl.username = 'orient_runtime_login';
  runtimeUrl.password = runtimePassword;
  const runtimePool = new Pool({
    connectionString: runtimeUrl.toString(),
    max: 1,
    application_name: 'orient-runtime-role-integration'
  });

  try {
    const { assertRuntimeDatabaseRole } = require('../../src/infrastructure/persistence/postgres/assert-runtime-database-role');
    assert.deepEqual(await assertRuntimeDatabaseRole(runtimePool), {
      role: 'orient_runtime_login',
      leastPrivilege: true
    });

    const runtimePersistence = new PostgresPersistence({ pool: runtimePool });
    const readiness = await runtimePersistence.initialize();
    assert.equal(readiness.schemaVersion, 12);

    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE orient_runtime');
      const elevated = await client.query('SELECT session_user::text AS session_user, current_user::text AS current_user');
      assert.equal(elevated.rows[0].session_user, 'orient_runtime_login');
      assert.equal(elevated.rows[0].current_user, 'orient_runtime');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const afterRelease = await runtimePool.query(
      'SELECT session_user::text AS session_user, current_user::text AS current_user'
    );
    assert.equal(afterRelease.rows[0].session_user, 'orient_runtime_login');
    assert.equal(afterRelease.rows[0].current_user, 'orient_runtime_login');
    assert.deepEqual(await assertRuntimeDatabaseRole(runtimePool), {
      role: 'orient_runtime_login',
      leastPrivilege: true
    });
  } finally {
    await runtimePool.end();
  }
});

test('PostgreSQL migration uses the restricted migrator login and resets owner role after migration', async () => {
  const migratorPassword = crypto.randomBytes(24).toString('hex');
  await provisionPostgresRoles({
    pool,
    migratorPassword,
    runtimePassword: crypto.randomBytes(24).toString('hex')
  });

  const migrationUrl = new URL(process.env.DATABASE_URL);
  migrationUrl.username = 'orient_migrator';
  migrationUrl.password = migratorPassword;
  const migrationPool = new Pool({
    connectionString: migrationUrl.toString(),
    max: 1,
    application_name: 'orient-migration-role-integration'
  });

  try {
    const { assertMigrationDatabaseRole } = require('../../src/infrastructure/persistence/postgres/assert-migration-database-role');
    assert.deepEqual(await assertMigrationDatabaseRole(migrationPool), {
      role: 'orient_migrator',
      targetRole: 'orient_owner',
      leastPrivilege: true
    });

    const migrationPersistence = new PostgresPersistence({ pool: migrationPool });
    const result = await migrationPersistence.migrate({ role: 'orient_owner' });
    assert.equal(result.schemaVersion, 12);

    const identityAfterMigration = await migrationPool.query(
      'SELECT session_user::text AS session_user, current_user::text AS current_user'
    );
    assert.equal(identityAfterMigration.rows[0].session_user, 'orient_migrator');
    assert.equal(identityAfterMigration.rows[0].current_user, 'orient_migrator');
    assert.deepEqual(await assertMigrationDatabaseRole(migrationPool), {
      role: 'orient_migrator',
      targetRole: 'orient_owner',
      leastPrivilege: true
    });
  } finally {
    await migrationPool.end();
  }
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

test('PostgreSQL checkpoint restores versioned ExecutionContext evidence after repository restart', async t => {
  const executionId = 'evidence-checkpoint-' + crypto.randomUUID();
  const tenantId = 'tenant-evidence-checkpoint';
  const execution = new ExecutionContext({
    requestId: 'request-' + crypto.randomUUID(),
    executionId,
    input: 'persist and restore execution evidence',
    tenantId,
    metadata: { tenantId }
  });
  execution.addObservation({
    step: 1,
    tool: 'execution.get',
    success: true,
    result: { status: 'running', checkpoint: 'durability-proof' }
  });
  const snapshot = execution.snapshot();
  assert.equal(snapshot.evidenceSchemaVersion, 1);
  const evidenceId = snapshot.observations[0].evidence.id;

  const restartedPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: 'orient-evidence-restart-integration'
  });
  t.after(async () => {
    try {
      await pool.query('DELETE FROM checkpoints WHERE execution_id=$1 AND tenant_id=$2', [executionId, tenantId]);
    } finally {
      await restartedPool.end();
    }
  });

  const saved = await persistence.checkpoints.save(snapshot, {
    reason: 'evidence_restart_test',
    tenantId
  });
  assert.equal(saved.snapshot.observations[0].evidence.id, evidenceId);

  const restartedPersistence = new PostgresPersistence({ pool: restartedPool });
  const persistedCheckpoint = await restartedPersistence.checkpoints.findLatest(executionId, {
    tenantId,
    verify: true
  });
  assert.ok(persistedCheckpoint);
  assert.equal(persistedCheckpoint.snapshotSha256, saved.snapshotSha256);

  const restored = ExecutionContext.restore(persistedCheckpoint.snapshot);
  assert.equal(restored.executionId, executionId);
  assert.equal(restored.observations.length, 1);
  assert.equal(restored.agentState.observations.length, 1);
  assert.equal(restored.observations[0].evidence.id, evidenceId);
  assert.equal(restored.agentState.observations[0].evidence.id, evidenceId);
  assert.equal(restored.observations[0].evidence.resultSha256, snapshot.observations[0].evidence.resultSha256);
});


test('PostgreSQL checkpoint verification rejects a tampered persisted snapshot', async t => {
  const executionId = 'tampered-evidence-checkpoint-' + crypto.randomUUID();
  const tenantId = 'tenant-tampered-evidence-checkpoint';
  const execution = new ExecutionContext({
    requestId: 'request-' + crypto.randomUUID(),
    executionId,
    input: 'verify checkpoint tamper detection',
    tenantId,
    metadata: { tenantId }
  });
  execution.addObservation({
    step: 1,
    tool: 'execution.get',
    success: true,
    result: { status: 'running', count: 4 }
  });

  t.after(async () => {
    await pool.query(
      'DELETE FROM checkpoints WHERE execution_id=$1 AND tenant_id=$2',
      [executionId, tenantId]
    );
  });

  await persistence.checkpoints.save(execution.snapshot(), { tenantId });
  const tampered = await pool.query(
    `UPDATE checkpoints
     SET snapshot=jsonb_set(snapshot, '{observations,0,result,count}', '99'::jsonb, false)
     WHERE execution_id=$1 AND tenant_id=$2`,
    [executionId, tenantId]
  );
  assert.equal(tampered.rowCount, 1);

  await assert.rejects(
    () => persistence.checkpoints.findLatest(executionId, { tenantId, verify: true }),
    error => error.code === 'CHECKPOINT_INTEGRITY_FAILED'
  );
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
    decisionAuthorizer: async ({ actorId, tenantId }) => actorId === 'test-owner' && tenantId === 'tenant-approval-service'
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

  await approvals.decide({
    approvalId: approval.approvalId,
    executionId: 'exec-approval-service',
    decision: 'approved',
    actorId: 'test-owner',
    tenantId: 'tenant-approval-service'
  });

  const persistedDecision = await persistence.approvals.findById(approval.approvalId, { tenantId: 'tenant-approval-service' });
  assert.equal(persistedDecision.decision.status, 'approved');
  assert.equal(persistedDecision.decision.actorId, 'test-owner');
  assert.equal((await persistence.approvals.findPending({ tenantId: 'tenant-approval-service' })).some(item => item.approvalId === approval.approvalId), false);

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


test('PostgreSQL owner chat is durable, idempotent, bounded, and isolated by owner', async () => {
  const ownerId = 'owner-chat-test-' + Date.now();
  const otherOwner = new PostgresOwnerChatConversationRepository(persistence.db, {
    ownerId: ownerId + '-other'
  });
  const chat = new PostgresOwnerChatConversationRepository(persistence.db, {
    ownerId,
    maxMessages: 3
  });

  try {
    const baseTime = Date.now();
    const first = {
      id: 'message-01',
      role: 'user',
      content: 'First owner message',
      createdAt: new Date(baseTime).toISOString()
    };
    const inserted = await chat.append(first);
    assert.equal(inserted.replayed, false);
    assert.equal(inserted.message.content, first.content);

    const replay = await chat.append(first);
    assert.equal(replay.replayed, true);
    assert.equal(replay.message.id, first.id);
    await assert.rejects(
      () => chat.append({ ...first, content: 'Different content under same id' }),
      error => error.code === 'OWNER_CHAT_IDEMPOTENCY_CONFLICT'
    );

    const linked = await chat.attachTaskId(first.id, 'task-01');
    assert.equal(linked.message.taskId, 'task-01');
    assert.equal((await chat.attachTaskId(first.id, 'task-01')).replayed, true);
    await assert.rejects(
      () => chat.attachTaskId(first.id, 'task-02'),
      error => error.code === 'OWNER_CHAT_TASK_LINK_CONFLICT'
    );

    for (let index = 2; index <= 4; index += 1) {
      await chat.append({
        id: 'message-0' + index,
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: 'Owner chat message ' + index,
        createdAt: new Date(baseTime + index * 1000).toISOString()
      });
    }

    const history = await chat.list();
    assert.equal(history.length, 3);
    assert.deepEqual(history.map(message => message.id), ['message-02', 'message-03', 'message-04']);
    assert.deepEqual(await otherOwner.list(), []);

    // A fresh repository instance sees the same persisted history after restart.
    const restarted = new PostgresOwnerChatConversationRepository(persistence.db, {
      ownerId,
      maxMessages: 3
    });
    assert.deepEqual(await restarted.list(), history);
  } finally {
    await chat.clear();
    await otherOwner.clear();
  }
});


test('PostgreSQL owner work profile persists validated partial updates and isolates owner scopes', async () => {
  const ownerId = 'owner-profile-test-' + Date.now();
  const otherOwnerId = ownerId + '-other';
  const profile = new PostgresOwnerWorkProfileRepository(persistence.db, { ownerId });
  const other = new PostgresOwnerWorkProfileRepository(persistence.db, { ownerId: otherOwnerId });

  try {
    assert.deepEqual(await profile.get(), {
      version: 1,
      mode: 'standard',
      workingPreferences: '',
      updatedAt: null
    });

    const saved = await profile.update({
      mode: 'plan-only',
      workingPreferences: 'Inspect evidence, define acceptance criteria, test before merging.'
    });
    assert.equal(saved.mode, 'plan-only');
    assert.equal(saved.workingPreferences, 'Inspect evidence, define acceptance criteria, test before merging.');
    assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));

    const partial = await profile.update({ workingPreferences: 'Updated preference' });
    assert.equal(partial.mode, 'plan-only');
    assert.equal(partial.workingPreferences, 'Updated preference');
    assert.ok(Date.parse(partial.updatedAt) >= Date.parse(saved.updatedAt));

    const restarted = new PostgresOwnerWorkProfileRepository(persistence.db, { ownerId });
    assert.deepEqual(await restarted.get(), partial);
    assert.equal((await other.get()).mode, 'standard');
    assert.equal((await other.get()).workingPreferences, '');

    await assert.rejects(
      () => profile.update({ mode: 'owner-admin' }),
      error => error.code === 'OWNER_PROFILE_MODE_INVALID'
    );
    await assert.rejects(
      () => profile.update({ workingPreferences: 'x'.repeat(4001) }),
      error => error.code === 'OWNER_PROFILE_PREFERENCES_INVALID'
    );
  } finally {
    await pool.query('DELETE FROM owner_work_profiles WHERE owner_id = ANY($1::text[])', [[ownerId, otherOwnerId]]);
  }
});


test('PostgreSQL runtime role is restricted and tenant RLS blocks cross-tenant CRUD', async () => {
  const role = await pool.query(
    "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication " +
    "FROM pg_roles WHERE rolname IN ('orient_owner','orient_runtime','orient_runtime_login','orient_migrator') ORDER BY rolname"
  );
  const runtime = role.rows.find(row => row.rolname === 'orient_runtime');
  const runtimeLogin = role.rows.find(row => row.rolname === 'orient_runtime_login');
  const owner = role.rows.find(row => row.rolname === 'orient_owner');
  const migrator = role.rows.find(row => row.rolname === 'orient_migrator');
  assert.equal(runtime.rolsuper, false);
  assert.equal(runtime.rolbypassrls, false);
  assert.equal(runtime.rolcanlogin, false);
  assert.equal(runtime.rolcreatedb, false);
  assert.equal(runtime.rolcreaterole, false);
  assert.equal(runtime.rolreplication, false);
  assert.equal(runtimeLogin.rolsuper, false);
  assert.equal(runtimeLogin.rolbypassrls, false);
  assert.equal(runtimeLogin.rolcanlogin, true);
  assert.equal(runtimeLogin.rolcreatedb, false);
  assert.equal(runtimeLogin.rolcreaterole, false);
  assert.equal(runtimeLogin.rolreplication, false);
  assert.equal(owner.rolcanlogin, false);
  assert.equal(owner.rolcreatedb, false);
  assert.equal(owner.rolcreaterole, false);
  assert.equal(owner.rolreplication, false);
  assert.equal(migrator.rolsuper, false);
  assert.equal(migrator.rolbypassrls, false);
  assert.equal(migrator.rolcreatedb, false);
  assert.equal(migrator.rolcreaterole, false);
  assert.equal(migrator.rolreplication, false);
  const privileges = await pool.query(
    "SELECT " +
    "has_schema_privilege('orient_runtime_login','public','CREATE') AS schema_create, " +
    "has_table_privilege('orient_runtime_login','public.executions','SELECT') AS can_select, " +
    "has_table_privilege('orient_runtime_login','public.executions','INSERT') AS can_insert, " +
    "has_table_privilege('orient_runtime_login','public.executions','UPDATE') AS can_update, " +
    "has_table_privilege('orient_runtime_login','public.executions','DELETE') AS can_delete, " +
    "has_table_privilege('orient_runtime_login','public.executions','TRUNCATE') AS can_truncate, " +
    "has_table_privilege('orient_runtime_login','public.executions','REFERENCES') AS can_reference, " +
    "has_table_privilege('orient_runtime_login','public.executions','TRIGGER') AS can_trigger, " +
    "has_sequence_privilege('orient_runtime_login','public.workflow_lease_fencing_seq','USAGE') AS sequence_usage, " +
    "has_sequence_privilege('orient_runtime_login','public.workflow_lease_fencing_seq','UPDATE') AS sequence_update"
  );
  assert.deepEqual(privileges.rows[0], {
    schema_create: false,
    can_select: true,
    can_insert: true,
    can_update: true,
    can_delete: true,
    can_truncate: false,
    can_reference: false,
    can_trigger: false,
    sequence_usage: true,
    sequence_update: false
  });
  const membership = await pool.query("SELECT pg_has_role('orient_runtime_login','orient_runtime','MEMBER') AS runtime_member, pg_has_role('orient_migrator','orient_owner','MEMBER') AS migrator_member");
  assert.equal(membership.rows[0].runtime_member, true);
  assert.equal(membership.rows[0].migrator_member, true);
  const tableOwner = await pool.query("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'public.executions'::regclass");
  assert.equal(tableOwner.rows[0].owner, 'orient_owner');

  const a = 'rls-a-' + crypto.randomUUID();
  const b = 'rls-b-' + crypto.randomUUID();
  const now = new Date().toISOString();
  await pool.query(
    'INSERT INTO executions(execution_id,tenant_id,payload,updated_at) VALUES ($1,$2,$3,$4),($5,$6,$7,$4)',
    [a,'tenant-a',{id:a,tenantId:'tenant-a'},now,b,'tenant-b',{id:b,tenantId:'tenant-b'}]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE orient_runtime');
    await client.query(
      "SELECT set_config('app.orient_tenant_id',$1,true), set_config('app.orient_owner_id',$2,true)",
      ['tenant-a','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
    );
    const visible = await client.query('SELECT execution_id FROM executions WHERE execution_id = ANY($1::text[]) ORDER BY execution_id',[ [a,b] ]);
    assert.deepEqual(visible.rows.map(row => row.execution_id), [a]);
    const changed = await client.query('UPDATE executions SET payload=$1 WHERE execution_id=$2', [{changed:true},b]);
    assert.equal(changed.rowCount, 0);
    const deleted = await client.query('DELETE FROM executions WHERE execution_id=$1',[b]);
    assert.equal(deleted.rowCount, 0);
    await assert.rejects(
      () => client.query(
        'INSERT INTO executions(execution_id,tenant_id,payload,updated_at) VALUES ($1,$2,$3,$4)',
        ['rls-insert-'+crypto.randomUUID(),'tenant-b',{id:'cross-tenant'},now]
      ),
      error => error.code === '42501'
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.query('DELETE FROM executions WHERE execution_id = ANY($1::text[])',[[a,b]]);
  }
});

test('PostgreSQL owner RLS blocks another owner chat profile', async () => {
  const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const messageA = 'owner-a-' + crypto.randomUUID();
  const messageB = 'owner-b-' + crypto.randomUUID();
  const now = new Date().toISOString();
  await pool.query(
    'INSERT INTO owner_chat_messages(owner_id,message_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5),($6,$7,$3,$4,$5)',
    [ownerA,messageA,'user','private A',now,ownerB,messageB]
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE orient_runtime');
    await client.query("SELECT set_config('app.orient_owner_id',$1,true)",[ownerA]);
    const visible = await client.query('SELECT message_id FROM owner_chat_messages ORDER BY message_id');
    assert.deepEqual(visible.rows.map(row => row.message_id), [messageA]);
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.query('DELETE FROM owner_chat_messages WHERE message_id = ANY($1::text[])',[[messageA,messageB]]);
  }
});


test('PostgreSQL Gateway RLS isolates challenge and idempotency rows by tenant, owner, and session', async () => {
  const tenantId = 'gateway-rls-' + crypto.randomUUID();
  const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';
  const sessionA2 = '33333333-3333-4333-8333-333333333333';
  const challengeA = crypto.randomUUID();
  const challengeB = crypto.randomUUID();
  const challengeA2 = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);
  const fingerprintA = 'a'.repeat(64);
  const fingerprintB = 'b'.repeat(64);
  const fingerprintA2 = 'c'.repeat(64);
  const keyA = 'gateway-rls-a-' + crypto.randomUUID();
  const keyB = 'gateway-rls-b-' + crypto.randomUUID();
  const keyA2 = 'gateway-rls-a2-' + crypto.randomUUID();

  await pool.query(
    `INSERT INTO gateway_challenges
     (challenge_id,owner_id,session_id,tenant_id,workspace_id,operation,operation_id,request_id,
      request_fingerprint,status,issued_at,expires_at)
     VALUES
     ($1,$2,$3,$4,'local','execution.get',$7,$8,$9,'ISSUED',$10,$11),
     ($5,$6,$12,$4,'local','execution.get',$13,$14,$15,'ISSUED',$10,$11),
     ($16,$2,$17,$4,'local','execution.get',$18,$19,$20,'ISSUED',$10,$11)`,
    [
      challengeA,ownerA,sessionA,tenantId,
      challengeB,ownerB,
      crypto.randomUUID(),crypto.randomUUID(),fingerprintA,now,expiresAt,
      sessionB,crypto.randomUUID(),crypto.randomUUID(),fingerprintB,
      challengeA2,sessionA2,crypto.randomUUID(),crypto.randomUUID(),fingerprintA2
    ]
  );
  await pool.query(
    `INSERT INTO gateway_idempotency
     (tenant_id,idempotency_key,request_fingerprint,owner_id,session_id,challenge_id,
      operation,operation_id,request_id,status,response,created_at,completed_at)
     VALUES
     ($1,$2,$3,$4,$5,$6,'execution.get',$7,$8,'COMPLETED','{"ok":true}'::jsonb,$9,$9),
     ($1,$10,$11,$12,$13,$14,'execution.get',$15,$16,'COMPLETED','{"ok":true}'::jsonb,$9,$9),
     ($1,$17,$18,$4,$19,$20,'execution.get',$21,$22,'COMPLETED','{"ok":true}'::jsonb,$9,$9)`,
    [
      tenantId,keyA,fingerprintA,ownerA,sessionA,challengeA,
      crypto.randomUUID(),crypto.randomUUID(),now,
      keyB,fingerprintB,ownerB,sessionB,challengeB,
      crypto.randomUUID(),crypto.randomUUID(),
      keyA2,fingerprintA2,sessionA2,challengeA2,crypto.randomUUID(),crypto.randomUUID()
    ]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE orient_runtime');
    await client.query(
      "SELECT set_config('app.orient_tenant_id',$1,true), set_config('app.orient_owner_id',$2,true), set_config('app.orient_session_id',$3,true)",
      [tenantId,ownerA,sessionA]
    );
    const visibleChallenges = await client.query(
      'SELECT challenge_id FROM gateway_challenges WHERE challenge_id = ANY($1::uuid[]) ORDER BY challenge_id',
      [[challengeA,challengeB,challengeA2]]
    );
    assert.deepEqual(visibleChallenges.rows.map(row => row.challenge_id), [challengeA]);

    const visibleIdempotency = await client.query(
      'SELECT idempotency_key FROM gateway_idempotency WHERE idempotency_key = ANY($1::text[]) ORDER BY idempotency_key',
      [[keyA,keyB,keyA2]]
    );
    assert.deepEqual(visibleIdempotency.rows.map(row => row.idempotency_key), [keyA]);

    const hiddenChallengeUpdate = await client.query(
      "UPDATE gateway_challenges SET status='CONSUMED',consumed_at=$1 WHERE challenge_id=$2",
      [now,challengeB]
    );
    assert.equal(hiddenChallengeUpdate.rowCount, 0);
    const hiddenIdempotencyDelete = await client.query(
      'DELETE FROM gateway_idempotency WHERE tenant_id=$1 AND idempotency_key=$2',
      [tenantId,keyB]
    );
    assert.equal(hiddenIdempotencyDelete.rowCount, 0);

    await assert.rejects(
      () => client.query(
        `INSERT INTO gateway_challenges
         (challenge_id,owner_id,session_id,tenant_id,workspace_id,operation,operation_id,request_id,
          request_fingerprint,status,issued_at,expires_at)
         VALUES($1,$2,$3,$4,'local','execution.get',$5,$6,$7,'ISSUED',$8,$9)`,
        [crypto.randomUUID(),ownerB,sessionB,tenantId,crypto.randomUUID(),crypto.randomUUID(),'d'.repeat(64),now,expiresAt]
      ),
      error => error.code === '42501'
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.query('DELETE FROM gateway_idempotency WHERE tenant_id=$1 AND idempotency_key = ANY($2::text[])',[tenantId,[keyA,keyB,keyA2]]);
    await pool.query('DELETE FROM gateway_challenges WHERE tenant_id=$1 AND challenge_id = ANY($2::uuid[])',[tenantId,[challengeA,challengeB,challengeA2]]);
  }
});

test('PostgreSQL role provisioning normalizes unexpected memberships and multiple grantors on a real server', async () => {
  const helperRole = 'orient_test_unrelated_admin';
  const grantorRole = 'orient_test_membership_grantor';
  const managedRoles = ['orient_owner', 'orient_migrator', 'orient_runtime', 'orient_runtime_login'];
  try {
    await pool.query('DROP ROLE IF EXISTS ' + helperRole);
    await pool.query('DROP ROLE IF EXISTS ' + grantorRole);
    await pool.query(
      'CREATE ROLE ' + helperRole + ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    );
    await pool.query(
      'CREATE ROLE ' + grantorRole + ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    );
    await pool.query('GRANT orient_owner TO orient_runtime_login WITH ADMIN OPTION');
    await pool.query('GRANT orient_owner TO ' + grantorRole + ' WITH ADMIN OPTION');
    const grantorClient = await pool.connect();
    try {
      await grantorClient.query('BEGIN');
      await grantorClient.query('SET LOCAL ROLE ' + grantorRole);
      await grantorClient.query('GRANT orient_owner TO orient_runtime_login WITH ADMIN OPTION');
      await grantorClient.query('COMMIT');
    } catch (error) {
      await grantorClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      grantorClient.release();
    }
    await pool.query('GRANT ' + helperRole + ' TO orient_migrator WITH ADMIN OPTION');

    const initialGrantors = await pool.query(
      'SELECT grantor.rolname AS grantor_role, membership.admin_option ' +
      'FROM pg_auth_members membership ' +
      'JOIN pg_roles granted ON granted.oid = membership.roleid ' +
      'JOIN pg_roles member ON member.oid = membership.member ' +
      'JOIN pg_roles grantor ON grantor.oid = membership.grantor ' +
      'WHERE granted.rolname = $1 AND member.rolname = $2 ' +
      'ORDER BY grantor.rolname',
      ['orient_owner', 'orient_runtime_login']
    );
    assert.deepEqual(initialGrantors.rows, [
      { grantor_role: 'orient_test_membership_grantor', admin_option: true },
      { grantor_role: 'postgres', admin_option: true }
    ]);

    await provisionPostgresRoles({
      pool,
      migratorPassword: crypto.randomBytes(24).toString('hex'),
      runtimePassword: crypto.randomBytes(24).toString('hex')
    });

    const memberships = await pool.query(
      'SELECT granted.rolname AS granted_role, member.rolname AS member_role, ' +
      'membership.admin_option, membership.inherit_option, membership.set_option ' +
      'FROM pg_auth_members membership ' +
      'JOIN pg_roles granted ON granted.oid = membership.roleid ' +
      'JOIN pg_roles member ON member.oid = membership.member ' +
      'WHERE granted.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[]) ' +
      'ORDER BY granted.rolname, member.rolname',
      [managedRoles]
    );

    assert.deepEqual(memberships.rows, [
      {
        granted_role: 'orient_owner',
        member_role: 'orient_migrator',
        admin_option: false,
        inherit_option: false,
        set_option: true
      },
      {
        granted_role: 'orient_runtime',
        member_role: 'orient_runtime_login',
        admin_option: false,
        inherit_option: true,
        set_option: true
      }
    ]);
  } finally {
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query('BEGIN');
      const residual = await cleanupClient.query(
        'SELECT granted.rolname AS granted_role, member.rolname AS member_role, grantor.rolname AS grantor_role ' +
        'FROM pg_auth_members membership ' +
        'JOIN pg_roles granted ON granted.oid = membership.roleid ' +
        'JOIN pg_roles member ON member.oid = membership.member ' +
        'JOIN pg_roles grantor ON grantor.oid = membership.grantor ' +
        'WHERE (granted.rolname = $1 AND member.rolname = ANY($2::text[])) ' +
        'OR (granted.rolname = $3 AND member.rolname = $4) ' +
        'ORDER BY CASE WHEN member.rolname = $5 THEN 0 ELSE 1 END',
        ['orient_owner', ['orient_runtime_login', grantorRole], helperRole, 'orient_migrator', 'orient_runtime_login']
      );
      for (const membership of residual.rows) {
        const quoteIdentifier = value => '"' + value.replace(/"/g, '""') + '"';
        await cleanupClient.query('SET LOCAL ROLE ' + quoteIdentifier(membership.grantor_role));
        await cleanupClient.query(
          'REVOKE ' + quoteIdentifier(membership.granted_role) +
          ' FROM ' + quoteIdentifier(membership.member_role)
        );
      }
      await cleanupClient.query('COMMIT');
    } catch (error) {
      await cleanupClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      cleanupClient.release();
    }
    await pool.query('DROP ROLE IF EXISTS ' + helperRole);
    await pool.query('DROP ROLE IF EXISTS ' + grantorRole);
  }
});


test('PostgreSQL gateway challenge consumption and idempotent mutation are atomic under retries and concurrency', async () => {
  const runtimePassword = crypto.randomBytes(24).toString('hex');
  await provisionPostgresRoles({
    pool,
    migratorPassword: crypto.randomBytes(24).toString('hex'),
    runtimePassword
  });
  const runtimeUrl = new URL(process.env.DATABASE_URL);
  runtimeUrl.username = 'orient_runtime_login';
  runtimeUrl.password = runtimePassword;
  const runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 8 });
  const runtimePersistence = new PostgresPersistence({ pool: runtimePool });
  const principal = {
    principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: 'gateway-atomic-tenant',
    workspaceId: 'gateway-atomic-workspace',
    authSource: 'orient-owner-session'
  };
  const binding = {
    ownerId: principal.ownerId,
    sessionId: principal.sessionId,
    tenantId: principal.tenantId,
    workspaceId: principal.workspaceId,
    challengeId: crypto.randomUUID(),
    operation: 'execution.create',
    operationId: crypto.randomUUID(),
    requestId: crypto.randomUUID()
  };
  const request = { goal: 'create one protected execution', priority: 'normal' };
  const idempotencyKey = 'gateway-' + crypto.randomUUID();
  const executionId = 'gateway-exec-' + crypto.randomUUID();

  try {
    await runtimePersistence.initialize();
    await runtimePersistence.gatewayIdentity.issue({
      ...binding,
      request,
      expiresAt: Date.now() + 60000
    }, { principal });
    const issued = await runtimePersistence.gatewayIdentity.getForIssuance(binding.challengeId, { principal });
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.tenantId, principal.tenantId);

    let callbackCalls = 0;
    const execute = async client => {
      callbackCalls += 1;
      await client.query(
        'INSERT INTO executions(execution_id,tenant_id,payload,updated_at) VALUES($1,$2,$3,NOW())',
        [executionId,principal.tenantId,{ id: executionId, tenantId: principal.tenantId, goal: request.goal }]
      );
      return { executionId, accepted: true };
    };
    const [first, concurrentRetry] = await Promise.all([
      runtimePersistence.gatewayIdentity.executeAtomically({
        principal,binding,idempotencyKey,request,execute
      }),
      runtimePersistence.gatewayIdentity.executeAtomically({
        principal,binding,idempotencyKey,request,execute
      })
    ]);
    assert.equal(callbackCalls, 1);
    assert.deepEqual(first.response, { executionId, accepted: true });
    assert.deepEqual(concurrentRetry.response, { executionId, accepted: true });
    assert.equal([first.replayed, concurrentRetry.replayed].filter(Boolean).length, 1);

    const replay = await runtimePersistence.gatewayIdentity.executeAtomically({
      principal,binding,idempotencyKey,request,
      execute: async () => { throw new Error('completed operation must not execute again'); }
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, { executionId, accepted: true });

    await assert.rejects(
      () => runtimePersistence.gatewayIdentity.executeAtomically({
        principal,binding,idempotencyKey,request:{ ...request, goal:'tampered request' },
        execute: async () => null
      }),
      error => error.code === 'GATEWAY_REQUEST_BINDING_MISMATCH'
    );
    await assert.rejects(
      () => runtimePersistence.gatewayIdentity.executeAtomically({
        principal,binding,idempotencyKey:idempotencyKey + '-other',
        request,execute: async () => null
      }),
      error => error.code === 'GATEWAY_CHALLENGE_REPLAY_REJECTED'
    );

    const stored = await runtimePersistence.withPrincipal(principal, async () => {
      const result = await runtimePersistence.db.query(
        'SELECT COUNT(*)::int AS count FROM executions WHERE execution_id=$1 AND tenant_id=$2',
        [executionId,principal.tenantId]
      );
      return Number(result.rows[0].count);
    });
    assert.equal(stored, 1);
  } finally {
    await runtimePool.end();
  }
});

test('PostgreSQL gateway transaction rolls back challenge consumption and idempotency when protected mutation fails', async () => {
  const runtimePassword = crypto.randomBytes(24).toString('hex');
  await provisionPostgresRoles({
    pool,
    migratorPassword: crypto.randomBytes(24).toString('hex'),
    runtimePassword
  });
  const runtimeUrl = new URL(process.env.DATABASE_URL);
  runtimeUrl.username = 'orient_runtime_login';
  runtimeUrl.password = runtimePassword;
  const runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 2 });
  const runtimePersistence = new PostgresPersistence({ pool: runtimePool });
  const principal = {
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ownerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    tenantId: 'gateway-rollback-tenant',
    workspaceId: 'gateway-rollback-workspace',
    authSource: 'orient-owner-session'
  };
  const binding = {
    ownerId: principal.ownerId,
    sessionId: principal.sessionId,
    tenantId: principal.tenantId,
    workspaceId: principal.workspaceId,
    challengeId: crypto.randomUUID(),
    operation: 'execution.create',
    operationId: crypto.randomUUID(),
    requestId: crypto.randomUUID()
  };
  try {
    await runtimePersistence.initialize();
    await runtimePersistence.gatewayIdentity.issue({
      ...binding,request:{ goal:'rollback' },expiresAt:Date.now()+60000
    }, { principal });
    await assert.rejects(
      () => runtimePersistence.gatewayIdentity.executeAtomically({
        principal,binding,idempotencyKey:'rollback-'+crypto.randomUUID(),request:{ goal:'rollback' },
        execute: async client => {
          await client.query(
            'INSERT INTO executions(execution_id,tenant_id,payload,updated_at) VALUES($1,$2,$3,NOW())',
            ['rollback-'+binding.challengeId,principal.tenantId,{ tenantId:principal.tenantId }]
          );
          throw Object.assign(new Error('simulated protected mutation failure'),{code:'TEST_MUTATION_FAILED'});
        }
      }),
      error => error.code === 'TEST_MUTATION_FAILED'
    );
    const challenge = await runtimePersistence.gatewayIdentity.getForIssuance(binding.challengeId, { principal });
    assert.equal(challenge.status,'ISSUED');
  } finally {
    await runtimePool.end();
  }
});

test('Gateway HTTP challenge, token, execution and replay complete against PostgreSQL under owner RLS', async () => {
  const runtimePassword = crypto.randomBytes(24).toString('hex');
  await provisionPostgresRoles({
    pool,
    migratorPassword: crypto.randomBytes(24).toString('hex'),
    runtimePassword
  });
  const runtimeUrl = new URL(process.env.DATABASE_URL);
  runtimeUrl.username = 'orient_runtime_login';
  runtimeUrl.password = runtimePassword;
  const runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 4 });
  const runtimePersistence = new PostgresPersistence({ pool: runtimePool });
  const ownerStateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-gateway-owner-'));
  const ownerStateFile = path.join(ownerStateDirectory, 'owner.json');
  const bootstrapPassword = 'gateway-owner-bootstrap-2026!';
  const initialOwnerIdentity = new OwnerIdentityService({
    stateFile: ownerStateFile,
    bootstrapPassword
  });
  const login = await initialOwnerIdentity.login({ username: 'Admin', password: bootstrapPassword });
  assert.equal(login.ok, true);
  assert.equal(login.passwordChangeRequired, true);
  const passwordChange = await initialOwnerIdentity.changePassword({
    token: login.token,
    password: 'gateway-owner-permanent-2026!',
    confirmPassword: 'gateway-owner-permanent-2026!'
  });
  assert.equal(passwordChange.ok, true);
  assert.equal(passwordChange.passwordChangeRequired, false);

  // Re-open the canonical owner store to prove the post-rotation session survives a process restart.
  const ownerIdentity = new OwnerIdentityService({ stateFile: ownerStateFile });
  const restoredSession = ownerIdentity.authenticate(passwordChange.token);
  assert.ok(restoredSession, 'the persisted owner session must authenticate after restart');
  const ownerId = restoredSession.ownerId;
  const sessionId = restoredSession.sessionId;
  const tenantId = 'gateway-http-' + crypto.randomUUID();
  const workspaceId = 'workspace-' + crypto.randomUUID();
  const sessionToken = passwordChange.token;
  const csrfToken = passwordChange.csrfToken;
  const idempotencyKey = 'gateway-http-' + crypto.randomUUID();
  const principal = {
    principalId: ownerId, ownerId, sessionId, tenantId, workspaceId,
    authSource: 'orient-owner-session'
  };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const tokenIssuer = new Ed25519IdentityTokenIssuer({ privateKey, kid: 'gateway-http-test-key' });
  const tokenVerifier = new Ed25519IdentityTokenVerifier({
    publicKeys: new Map([['gateway-http-test-key', publicKey]])
  });
  let challengeId = null;
  let server;
  try {
    await runtimePersistence.initialize();
    const authority = new OwnerSessionIdentityAuthority({
      ownerIdentity,
      tokenIssuer,
      challengeStore: runtimePersistence.gatewayIdentity,
      tenantId,
      workspaceId,
      operationScopes: GATEWAY_OPERATION_SCOPES
    });
    const identityRoutes = createGatewayIdentityRoutes({
      repository: runtimePersistence.gatewayIdentity,
      authority,
      tenantId,
      workspaceId
    });
    const executionService = new GatewayIdentityExecutionService({
      tokenVerifier,
      gatewayIdentityRepository: runtimePersistence.gatewayIdentity,
      operationScopes: GATEWAY_OPERATION_SCOPES,
      sessionAuthorizer: ({ ownerId: verifiedOwner, sessionId: verifiedSession }) =>
        verifiedOwner === ownerId && ownerIdentity.isActiveSession(verifiedSession)
    });
    server = createServer({
      memoryRoutes: {},
      agentRoutes: {},
      ownerAuth: {
        enabled: true,
        authenticate(token) {
          const ownerSession = ownerIdentity.authenticate(token);
          if (!ownerSession) return null;
          return {
            ...ownerSession,
            principal: Object.freeze({
              principalId: ownerSession.ownerId,
              ownerId: ownerSession.ownerId,
              tenantId,
              workspaceId,
              authSource: 'orient-owner-session',
              sessionId: ownerSession.sessionId
            })
          };
        },
        status() { return ownerIdentity.status(); },
        verifyCsrf(ownerSession, token) { return ownerIdentity.verifyCsrf(ownerSession, token); }
      },
      gatewayIdentityRoutes: identityRoutes,
      gatewayIdentityExecutionService: executionService,
      gatewayOperationHandlers: createGatewayOperationHandlers()
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const post = (path, body, { authorization = null, key = null } = {}) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = require('node:http').request({
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:' + port,
          host: '127.0.0.1:' + port,
          cookie: 'orient_owner_session=' + sessionToken,
          'x-orient-csrf': csrfToken,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(authorization ? { authorization } : {}),
          ...(key ? { 'idempotency-key': key } : {})
        }
      }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(data) }));
      });
      request.on('error', reject);
      request.end(payload);
    });

    const requestPayload = { executionId: 'task-not-found-' + crypto.randomUUID() };
    const created = await post('/owner/gateway/challenges', {
      operation: 'execution.get', request: requestPayload
    });
    assert.equal(created.statusCode, 201);
    challengeId = created.body.challenge.challengeId;
    const binding = {
      challengeId,
      operation: 'execution.get',
      operationId: created.body.challenge.operationId,
      requestId: created.body.challenge.requestId
    };
    const issued = await post('/owner/gateway/identity-token', binding);
    assert.equal(issued.statusCode, 200);
    const authorization = 'Bearer ' + issued.body.identity.token;
    const executeBody = { ...binding, request: requestPayload };
    const first = await post('/owner/gateway/execute', executeBody, { authorization, key: idempotencyKey });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.replayed, false);
    assert.deepEqual(first.body.response, { found: false, task: null });

    const replay = await post('/owner/gateway/execute', executeBody, { authorization, key: idempotencyKey });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.response, first.body.response);

    const tampered = await post('/owner/gateway/execute', {
      ...binding, request: { executionId: 'different-task-id' }
    }, { authorization, key: idempotencyKey + '-tampered' });
    assert.equal(tampered.statusCode, 409);
    assert.equal(tampered.body.code, 'GATEWAY_REQUEST_BINDING_MISMATCH');

    assert.equal(ownerIdentity.logout(sessionToken), true);
    await assert.rejects(
      () => executionService.execute({
        token: issued.body.identity.token,
        challengeId,
        operation: binding.operation,
        operationId: binding.operationId,
        requestId: binding.requestId,
        idempotencyKey,
        request: requestPayload,
        ownerSessionId: sessionId,
        execute: async () => ({ shouldNotExecute: true })
      }),
      error => error.code === 'GATEWAY_SESSION_REJECTED'
    );
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(ownerStateDirectory, { recursive: true, force: true });
    if (challengeId) {
      await runtimePersistence.withPrincipal(principal, async () => {
        await runtimePersistence.db.query(
          'DELETE FROM gateway_idempotency WHERE tenant_id=$1 AND idempotency_key=$2',
          [tenantId, idempotencyKey]
        );
        await runtimePersistence.db.query(
          'DELETE FROM gateway_challenges WHERE tenant_id=$1 AND challenge_id=$2',
          [tenantId, challengeId]
        );
      }).catch(() => {});
    }
    await runtimePool.end();
  }
});
