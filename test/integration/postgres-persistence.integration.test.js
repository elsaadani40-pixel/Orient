const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { PostgresPersistence, PostgresOwnerChatConversationRepository, PostgresOwnerWorkProfileRepository } = require('../../src/infrastructure/persistence/postgres/postgres-persistence');
const { randomUUID } = require('node:crypto');
const { createPersistencePrincipal } = require('../../src/infrastructure/persistence/postgres/persistence-principal');
const { createWorkerPersistencePrincipal } = require('../../src/core/security/worker-persistence-principal');

function makeOwnerPrincipal(tenantId, ownerId) {
  return createPersistencePrincipal({ tenantId, ownerId, sessionId: 'session-' + randomUUID() });
}

function makeWorkerPrincipal(tenantId, workerId, capabilities = []) {
  return createWorkerPersistencePrincipal({
    tenantId, workerId, sessionId: 'worker-session-' + randomUUID(), capabilities
  });
}
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
  assert.deepEqual(result.rows.map(row => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const workerColumns = await pool.query(
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='worker_nodes' AND column_name='session_id') OR (table_name='workflow_dispatch_claims' AND column_name='worker_session_id') OR (table_name='workflow_leases' AND column_name='worker_session_id'))"
  );
  assert.deepEqual(
    workerColumns.rows.map(row => row.table_name + '.' + row.column_name).sort(),
    ['worker_nodes.session_id', 'workflow_dispatch_claims.worker_session_id', 'workflow_leases.worker_session_id']
  );
});


test('PostgreSQL v9 upgrades populated v8 owner tables without losing rows and isolates tenant keys', async () => {
  const { MIGRATIONS } = require('../../src/infrastructure/persistence/postgres/postgres-database');
  const migration = MIGRATIONS.find(item => item.version === 9);
  assert.ok(migration, 'version 9 migration must be registered');

  const client = await pool.connect();
  const schema = 'orient_v9_upgrade_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  const quotedSchema = '"' + schema.replace(/"/g, '""') + '"';
  try {
    await client.query('CREATE SCHEMA ' + quotedSchema);
    await client.query('SET search_path TO ' + quotedSchema);
    await client.query(`
      CREATE TABLE owner_chat_messages (
        owner_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
        created_at TIMESTAMPTZ NOT NULL,
        task_id TEXT,
        PRIMARY KEY (owner_id, message_id)
      );
      CREATE INDEX idx_owner_chat_messages_order
        ON owner_chat_messages(owner_id, created_at, message_id);
      CREATE INDEX idx_owner_chat_messages_task
        ON owner_chat_messages(owner_id, task_id) WHERE task_id IS NOT NULL;
      CREATE TABLE owner_work_profiles (
        owner_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('standard','read-only-audit','plan-only')),
        working_preferences TEXT NOT NULL CHECK (length(working_preferences) <= 4000),
        updated_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO owner_chat_messages(owner_id,message_id,role,content,created_at)
      VALUES ('owner-a','message-a','user','preserve this row',NOW());
      INSERT INTO owner_work_profiles(owner_id,mode,working_preferences,updated_at)
      VALUES ('owner-a','plan-only','preserve this profile',NOW());
    `);

    await client.query(migration.sql);

    const preservedMessage = await client.query(
      'SELECT tenant_id, owner_id, message_id, content FROM owner_chat_messages WHERE owner_id=$1 AND message_id=$2',
      ['owner-a', 'message-a']
    );
    assert.equal(preservedMessage.rows.length, 1);
    assert.equal(preservedMessage.rows[0].tenant_id, 'local');
    assert.equal(preservedMessage.rows[0].content, 'preserve this row');

    const preservedProfile = await client.query(
      'SELECT tenant_id, owner_id, mode, working_preferences FROM owner_work_profiles WHERE owner_id=$1',
      ['owner-a']
    );
    assert.equal(preservedProfile.rows.length, 1);
    assert.equal(preservedProfile.rows[0].tenant_id, 'local');
    assert.equal(preservedProfile.rows[0].mode, 'plan-only');
    assert.equal(preservedProfile.rows[0].working_preferences, 'preserve this profile');

    await client.query(
      `INSERT INTO owner_chat_messages(tenant_id,owner_id,message_id,role,content,created_at)
       VALUES ('tenant-b','owner-a','message-a','user','other tenant row',NOW())`
    );
    await client.query(
      `INSERT INTO owner_work_profiles(tenant_id,owner_id,mode,working_preferences,updated_at)
       VALUES ('tenant-b','owner-a','standard','other tenant profile',NOW())`
    );
    const isolated = await client.query(
      'SELECT tenant_id, content FROM owner_chat_messages WHERE owner_id=$1 AND message_id=$2 ORDER BY tenant_id',
      ['owner-a', 'message-a']
    );
    assert.deepEqual(isolated.rows.map(row => row.tenant_id), ['local', 'tenant-b']);
    assert.equal(isolated.rows[1].content, 'other tenant row');
  } finally {
    await client.query('RESET search_path').catch(() => {});
    await client.query('DROP SCHEMA IF EXISTS ' + quotedSchema + ' CASCADE').catch(() => {});
    client.release();
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

  const workerA = makeWorkerPrincipal('tenant-fence', 'worker-a');
  const workerB = makeWorkerPrincipal('tenant-fence', 'worker-b');
  for (const principal of [workerA, workerB]) {
    await persistence.workers.register({
      workerId: principal.workerId, tenantId: 'tenant-fence', status: 'READY', capabilities: [],
      heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
    }, 'tenant-fence', { workerPrincipal: principal });
  }
  const first = await persistence.workflowLeases.tryAcquire({
    workflowId,
    leaseId: 'lease-a-' + Date.now(),
    workerId: 'worker-a',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-fence' }
  }, 'tenant-fence', { workerPrincipal: workerA });

  assert.ok(first.fencingToken > 0);
  const firstBound = createWorkerPersistencePrincipal({tenantId:'tenant-fence',workerId:'worker-a',sessionId:workerA.sessionId,capabilities:workerA.capabilities,workflowId,leaseId:first.leaseId,fencingToken:first.fencingToken});

  await persistence.workflows.save({
    workflowId,
    tenantId: 'tenant-fence',
    state: 'RUNNING',
    metadata: { fencingToken: first.fencingToken },
    toJSON() { return this; }
  }, 'tenant-fence', {workerPrincipal:firstBound});

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
  }, 'tenant-fence', { workerPrincipal: workerB });

  assert.ok(second.fencingToken > first.fencingToken);

  await assert.rejects(
    () => persistence.workflows.save({
      workflowId,
      tenantId: 'tenant-fence',
      state: 'RUNNING',
      metadata: { fencingToken: first.fencingToken },
      toJSON() { return this; }
    }, 'tenant-fence', {workerPrincipal:firstBound}),
    error => error.code === 'WORKFLOW_FENCING_REJECTED'
  );

  const secondBound = createWorkerPersistencePrincipal({tenantId:'tenant-fence',workerId:'worker-b',sessionId:workerB.sessionId,capabilities:workerB.capabilities,workflowId,leaseId:second.leaseId,fencingToken:second.fencingToken});
  await persistence.workflows.save({
    workflowId,
    tenantId: 'tenant-fence',
    state: 'RUNNING',
    metadata: { fencingToken: second.fencingToken },
    toJSON() { return this; }
  }, 'tenant-fence', {workerPrincipal:secondBound});
  await persistence.workflowLeases.delete(workflowId, second.leaseId, 'tenant-fence', {workerPrincipal:secondBound});
  await persistence.workers.unregister('worker-a','tenant-fence',{workerPrincipal:workerA});
  await persistence.workers.unregister('worker-b','tenant-fence',{workerPrincipal:workerB});
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});


test('PostgreSQL rejects stale lease renewal after takeover', async () => {
  const workflowId = 'renew-fence-wf-' + Date.now();
  await pool.query(
    "INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,'tenant-renew','RUNNING',NOW(),$2)",
    [workflowId, { workflowId, tenantId: 'tenant-renew', state: 'RUNNING', metadata: {} }]
  );

  const workerA = makeWorkerPrincipal('tenant-renew', 'renew-worker-a');
  const workerB = makeWorkerPrincipal('tenant-renew', 'renew-worker-b');
  for (const principal of [workerA, workerB]) {
    await persistence.workers.register({
      workerId: principal.workerId, tenantId: 'tenant-renew', status: 'READY', capabilities: [],
      heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
    }, 'tenant-renew', { workerPrincipal: principal });
  }
  const first = await persistence.workflowLeases.tryAcquire({
    workflowId,
    leaseId: 'renew-lease-a-' + Date.now(),
    workerId: 'renew-worker-a',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-renew' }
  }, 'tenant-renew', {workerPrincipal:workerA});

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
  }, 'tenant-renew', {workerPrincipal:workerB});

  assert.ok(second.fencingToken > first.fencingToken);
  assert.equal(
    await persistence.workflowLeases.renewIfOwned(
      workflowId,
      first.leaseId,
      Date.now() + 60000,
      Date.now(),
      'tenant-renew',
      {workerPrincipal:createWorkerPersistencePrincipal({tenantId:'tenant-renew',workerId:'renew-worker-a',sessionId:workerA.sessionId,capabilities:workerA.capabilities,workflowId,leaseId:first.leaseId,fencingToken:first.fencingToken})}
    ),
    false
  );
  assert.equal(
    await persistence.workflowLeases.renewIfOwned(
      workflowId,
      second.leaseId,
      Date.now() + 60000,
      Date.now(),
      'tenant-renew',
      {workerPrincipal:createWorkerPersistencePrincipal({tenantId:'tenant-renew',workerId:'renew-worker-b',sessionId:workerB.sessionId,capabilities:workerB.capabilities,workflowId,leaseId:second.leaseId,fencingToken:second.fencingToken})}
    ),
    true
  );

  await persistence.workflowLeases.delete(workflowId, second.leaseId, 'tenant-renew', {workerPrincipal:createWorkerPersistencePrincipal({tenantId:'tenant-renew',workerId:'renew-worker-b',sessionId:workerB.sessionId,capabilities:workerB.capabilities,workflowId,leaseId:second.leaseId,fencingToken:second.fencingToken})});
  await persistence.workers.unregister('renew-worker-a','tenant-renew',{workerPrincipal:workerA});
  await persistence.workers.unregister('renew-worker-b','tenant-renew',{workerPrincipal:workerB});
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});


test('PostgreSQL lease authority is revoked when the registered worker session is replaced', async () => {
  const workflowId = 'replaced-session-lease-' + Date.now();
  const tenantId = 'tenant-replaced-session';
  await pool.query(
    'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,$2,$3,NOW(),$4)',
    [workflowId, tenantId, 'QUEUED', { workflowId, tenantId, state: 'QUEUED', metadata: {} }]
  );
  const oldWorker = makeWorkerPrincipal(tenantId, 'worker-replaced');
  await persistence.workers.register({
    workerId: oldWorker.workerId, tenantId, status: 'READY', capabilities: [],
    heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
  }, tenantId, { workerPrincipal: oldWorker });
  const lease = await persistence.workflowLeases.tryAcquire({
    workflowId, leaseId: 'lease-old-session-' + Date.now(), workerId: oldWorker.workerId,
    acquiredAt: Date.now(), expiresAt: Date.now() + 60000, metadata: { tenantId }
  }, tenantId, { workerPrincipal: oldWorker });
  const oldLeasePrincipal = createWorkerPersistencePrincipal({
    tenantId, workerId: oldWorker.workerId, sessionId: oldWorker.sessionId,
    capabilities: oldWorker.capabilities, workflowId, leaseId: lease.leaseId,
    fencingToken: lease.fencingToken
  });

  await pool.query(
    'UPDATE worker_nodes SET expires_at=NOW()-INTERVAL \'1 second\' WHERE tenant_id=$1 AND worker_id=$2',
    [tenantId, oldWorker.workerId]
  );
  const newWorker = makeWorkerPrincipal(tenantId, 'worker-replaced');
  await persistence.workers.register({
    workerId: newWorker.workerId, tenantId, status: 'READY', capabilities: [],
    heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
  }, tenantId, { workerPrincipal: newWorker });

  await assert.rejects(
    persistence.workflowLeases.renewIfOwned(workflowId, lease.leaseId, Date.now() + 30000, Date.now(), tenantId, { workerPrincipal: oldLeasePrincipal }),
    error => error.code === 'WORKER_SESSION_LOST'
  );
  await assert.rejects(
    persistence.workflowLeases.assertCurrent(workflowId, lease.leaseId, lease.fencingToken, Date.now(), tenantId, { workerPrincipal: oldLeasePrincipal }),
    error => error.code === 'WORKER_SESSION_LOST'
  );
  await assert.rejects(
    persistence.workflowLeases.delete(workflowId, lease.leaseId, tenantId, { workerPrincipal: oldLeasePrincipal }),
    error => error.code === 'WORKER_SESSION_LOST'
  );
  assert.equal(
    await persistence.workflowLeases.delete(workflowId, lease.leaseId, tenantId, {
      workerPrincipal: createWorkerPersistencePrincipal({
        tenantId, workerId: newWorker.workerId, sessionId: newWorker.sessionId,
        capabilities: newWorker.capabilities, workflowId, leaseId: lease.leaseId,
        fencingToken: lease.fencingToken
      })
    }),
    false
  );

  await persistence.workers.unregister(newWorker.workerId, tenantId, { workerPrincipal: newWorker });
  await pool.query('DELETE FROM workflow_leases WHERE workflow_id=$1 AND tenant_id=$2', [workflowId, tenantId]);
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1 AND tenant_id=$2', [workflowId, tenantId]);
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

  const crashedPrincipal = makeWorkerPrincipal('tenant-recovery', 'crashed-worker');
  await persistence.workers.register({
    workerId: 'crashed-worker', tenantId: 'tenant-recovery', status: 'READY', capabilities: [],
    heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
  }, 'tenant-recovery', {workerPrincipal:crashedPrincipal});
  const firstLease = await persistence.workflowLeases.tryAcquire({
    workflowId,
    leaseId: 'crash-lease-a-' + Date.now(),
    workerId: 'crashed-worker',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 30000,
    metadata: { tenantId: 'tenant-recovery' }
  }, 'tenant-recovery', {workerPrincipal:crashedPrincipal});

  await pool.query(
    "UPDATE workflow_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
    [workflowId]
  );

  const recoveryPrincipal = makeWorkerPrincipal('tenant-recovery', 'recovery-worker');
  await persistence.workers.register({
    workerId: 'recovery-worker', tenantId: 'tenant-recovery', status: 'READY',
    capabilities: [], heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  }, 'tenant-recovery', { workerPrincipal: recoveryPrincipal });

  const scheduler = new AsyncWorkflowScheduler({
    workflowRepository: persistence.workflows,
    leaseRepository: persistence.workflowLeases,
    tenantId: 'tenant-recovery',
    leaseDurationMs: 30000
  });

  const persistedLease = await persistence.workflowLeases.findByWorkflowId(workflowId, 'tenant-recovery');
  assert.ok(persistedLease.expiresAt <= Date.now());

  const recovered = await scheduler.recoverPersisted('recovery-worker', [], recoveryPrincipal);
  assert.equal(recovered, 1);
  assert.equal(scheduler.queue.length, 1);
  assert.equal(scheduler.queue[0].instance.state, 'QUEUED');

  const takeover = await scheduler.leaseAsync('recovery-worker', [], recoveryPrincipal);
  assert.ok(takeover);
  assert.equal(takeover.workflowId, workflowId);
  assert.ok(takeover.fencingToken > firstLease.fencingToken);
  assert.equal(takeover.instance.state, 'RUNNING');

  await scheduler.releaseAsync(workflowId, takeover.leaseId);
  await persistence.workers.unregister('recovery-worker', 'tenant-recovery', { workerPrincipal: recoveryPrincipal });
  await persistence.workers.unregister('crashed-worker', 'tenant-recovery', { workerPrincipal: crashedPrincipal });
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

  const workerPrincipalA = makeWorkerPrincipal(tenantId, 'stale-worker-a');
  const workerPrincipalB = makeWorkerPrincipal(tenantId, 'recovery-worker-b');
  await persistence.workers.register({
    workerId: 'stale-worker-a', tenantId, status: 'READY', capabilities: [],
    heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
  }, tenantId, { workerPrincipal: workerPrincipalA });
  await persistence.workers.register({
    workerId: 'recovery-worker-b', tenantId, status: 'READY', capabilities: [],
    heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
  }, tenantId, { workerPrincipal: workerPrincipalB });

  await schedulerA.enqueueDurable(instance);

  let takeover = null;
  let allowInitialRenew = true;
  const workerA = new AsyncWorkflowWorker({
    scheduler: schedulerA,
    workerId: 'stale-worker-a',
    workerPrincipal: workerPrincipalA,
    executor: async () => {
      await pool.query(
        "UPDATE workflow_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
        [workflowId]
      );
      const recovered = await schedulerB.recoverPersisted('recovery-worker-b', [], workerPrincipalB);
      assert.equal(recovered, 1);

      const workerB = new AsyncWorkflowWorker({
        scheduler: schedulerB,
        workerId: 'recovery-worker-b',
        workerPrincipal: workerPrincipalB,
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
  assert.equal(takeover.metadata.fencingToken, undefined, 'released workflow instances must not retain stale fencing metadata');

  const persisted = await persistence.workflows.findById(workflowId, tenantId);
  assert.equal(persisted.state, 'COMPLETED');
  assert.equal(persisted.metadata.fencingToken, undefined, 'durable workflow state must clear fencing metadata after lease release');
  assert.equal(persisted.steps['protected-step'].state, 'COMPLETED');
  assert.equal(persisted.steps['protected-step'].result.committedBy, 'worker-b');

  await persistence.workers.unregister('stale-worker-a', tenantId, { workerPrincipal: workerPrincipalA });
  await persistence.workers.unregister('recovery-worker-b', tenantId, { workerPrincipal: workerPrincipalB });
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

  const quotaWorkerPrincipalA = makeWorkerPrincipal(tenantId, 'quota-worker-a');
  const quotaWorkerPrincipalB = makeWorkerPrincipal(tenantId, 'quota-worker-b');
  for (const workerPrincipal of [quotaWorkerPrincipalA, quotaWorkerPrincipalB]) {
    await persistence.workers.register({
      workerId: workerPrincipal.workerId, tenantId, status: 'READY', capabilities: [],
      heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
    }, tenantId, { workerPrincipal });
  }

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
  const leaseA = await schedulerA.leaseAsync('quota-worker-a', [], quotaWorkerPrincipalA);
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

  const recovered = await schedulerB.recoverPersisted('quota-worker-b', [], quotaWorkerPrincipalB);
  assert.equal(recovered, 1);
  const leaseB = await schedulerB.leaseAsync('quota-worker-b', [], quotaWorkerPrincipalB);
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

  await persistence.workers.unregister('quota-worker-a', tenantId, { workerPrincipal: quotaWorkerPrincipalA });
  await persistence.workers.unregister('quota-worker-b', tenantId, { workerPrincipal: quotaWorkerPrincipalB });
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

  const cancelPrincipal = makeWorkerPrincipal('tenant-cancel', 'worker-cancel');
  await persistence.workers.register({
    workerId: 'worker-cancel', tenantId: 'tenant-cancel', status: 'READY', capabilities: [],
    heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
  }, 'tenant-cancel', {workerPrincipal:cancelPrincipal});
  await assert.rejects(
    () => persistence.workflowLeases.tryAcquire({
      workflowId,
      leaseId: 'cancel-lease-' + Date.now(),
      workerId: 'worker-cancel',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30000,
      metadata: { tenantId: 'tenant-cancel' }
    }, 'tenant-cancel', {workerPrincipal:cancelPrincipal}),
    error => error.code === 'WORKFLOW_CANCELLATION_REQUESTED'
  );
  await persistence.workers.unregister('worker-cancel','tenant-cancel',{workerPrincipal:cancelPrincipal});

  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});

test('PostgreSQL durable claims require a live registered worker identity', async () => {
  const workflowId = 'worker-auth-' + Date.now();
  await pool.query(
    "INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,'tenant-worker-auth','QUEUED',NOW(),$2)",
    [workflowId, { workflowId, tenantId: 'tenant-worker-auth', state: 'QUEUED', metadata: {} }]
  );

  const unregisteredPrincipal = makeWorkerPrincipal('tenant-worker-auth', 'unregistered-worker');
  await assert.rejects(
    () => persistence.workflows.claimQueued({
      tenantId: 'tenant-worker-auth',
      workerId: 'unregistered-worker',
      limit: 1,
      workerPrincipal: unregisteredPrincipal
    }),
    error => error.code === 'WORKER_SESSION_LOST'
  );

  const registeredPrincipal = makeWorkerPrincipal('tenant-worker-auth', 'registered-worker', ['research.read']);
  await persistence.workers.register({
    workerId: 'registered-worker',
    tenantId: 'tenant-worker-auth',
    status: 'READY',
    capabilities: ['research.read'],
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  }, 'tenant-worker-auth', { workerPrincipal: registeredPrincipal });

  const claimed = await persistence.workflows.claimQueued({
    tenantId: 'tenant-worker-auth',
    workerId: 'registered-worker',
    workerCapabilities: ['research.read'],
    limit: 1,
    workerPrincipal: registeredPrincipal
  });
  assert.equal(claimed.length, 1);

  const replacedSession = makeWorkerPrincipal('tenant-worker-auth', 'registered-worker', ['research.read']);
  await assert.rejects(
    persistence.workflows.claimQueued({
      tenantId: 'tenant-worker-auth',
      workerId: 'registered-worker',
      workerCapabilities: ['research.read'],
      limit: 1,
      workerPrincipal: replacedSession
    }),
    error => error.code === 'WORKER_SESSION_LOST'
  );

  await persistence.workflows.releaseDispatchClaim(workflowId, 'registered-worker', 'tenant-worker-auth', { workerPrincipal: registeredPrincipal });
  await persistence.workers.unregister('registered-worker', 'tenant-worker-auth', { workerPrincipal: registeredPrincipal });
  await pool.query('DELETE FROM workflows WHERE workflow_id=$1', [workflowId]);
});

test('PostgreSQL dispatch claims are exclusive across concurrent workers and expire safely', async () => {
  const workflowId = 'claim-wf-' + Date.now();
  await pool.query(
    "INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,'tenant-claim','QUEUED',NOW(),$2)",
    [workflowId, { workflowId, tenantId: 'tenant-claim', state: 'QUEUED', metadata: {} }]
  );

  const workers = ['worker-a', 'worker-b', 'worker-recovery'].map(id => id + '-' + Date.now());
  const workerPrincipals = new Map();
  for (const workerId of workers) {
    const workerPrincipal = makeWorkerPrincipal('tenant-claim', workerId);
    workerPrincipals.set(workerId, workerPrincipal);
    await persistence.workers.register({
      workerId,
      tenantId: 'tenant-claim',
      status: 'READY',
      capabilities: [],
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    }, 'tenant-claim', { workerPrincipal });
  }
  const [workerA, workerB] = workers;

  const [a, b] = await Promise.all([
    persistence.workflows.claimQueued({
      tenantId: 'tenant-claim',
      workerId: workerA,
      limit: 1,
      claimTtlMs: 60000,
      workerPrincipal: workerPrincipals.get(workerA)
    }),
    persistence.workflows.claimQueued({
      tenantId: 'tenant-claim',
      workerId: workerB,
      limit: 1,
      claimTtlMs: 60000,
      workerPrincipal: workerPrincipals.get(workerB)
    })
  ]);

  assert.equal(a.length + b.length, 1);

  const winningWorker = a.length ? workerA : workerB;
  const staleSessionForWinner = makeWorkerPrincipal('tenant-claim', winningWorker);
  assert.equal(await persistence.workflows.releaseDispatchClaim(
    workflowId, winningWorker, 'tenant-claim', { workerPrincipal: staleSessionForWinner }
  ), false);

  await pool.query(
    "UPDATE workflow_dispatch_claims SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1",
    [workflowId]
  );

  const workerRecovery = workers[2];

  const recovered = await persistence.workflows.claimQueued({
    tenantId: 'tenant-claim',
    workerId: workerRecovery,
    limit: 1,
    claimTtlMs: 60000,
    workerPrincipal: workerPrincipals.get(workerRecovery)
  });
  assert.equal(recovered.length, 1);

  await persistence.workflows.releaseDispatchClaim(workflowId, workerRecovery, 'tenant-claim', { workerPrincipal: workerPrincipals.get(workerRecovery) });
  for (const workerId of workers) await persistence.workers.unregister(workerId, 'tenant-claim', { workerPrincipal: workerPrincipals.get(workerId) });
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


test('PostgreSQL owner chat requires a validated principal and isolates tenant and owner scopes', async () => {
  const suffix = randomUUID();
  const tenantId = 'tenant-owner-chat-' + suffix;
  const ownerId = 'owner-chat-test-' + suffix;
  const principal = makeOwnerPrincipal(tenantId, ownerId);
  const otherOwnerPrincipal = makeOwnerPrincipal(tenantId, ownerId + '-other');
  const otherTenantPrincipal = makeOwnerPrincipal(tenantId + '-other', ownerId);
  const chat = new PostgresOwnerChatConversationRepository(persistence.db, { maxMessages: 3 });
  const otherOwner = new PostgresOwnerChatConversationRepository(persistence.db);
  const otherTenant = new PostgresOwnerChatConversationRepository(persistence.db);

  await assert.rejects(
    () => chat.list({ tenantId, ownerId, sessionId: 'forged-session' }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_REQUIRED'
  );

  try {
    const baseTime = Date.now();
    const first = {
      id: 'message-01',
      role: 'user',
      content: 'First owner message',
      createdAt: new Date(baseTime).toISOString()
    };
    const inserted = await chat.append(first, principal);
    assert.equal(inserted.replayed, false);
    assert.equal(inserted.message.content, first.content);

    const replay = await chat.append(first, principal);
    assert.equal(replay.replayed, true);
    assert.equal(replay.message.id, first.id);
    await assert.rejects(
      () => chat.append({ ...first, content: 'Different content under same id' }, principal),
      error => error.code === 'OWNER_CHAT_IDEMPOTENCY_CONFLICT'
    );

    const linked = await chat.attachTaskId(first.id, 'task-01', principal);
    assert.equal(linked.message.taskId, 'task-01');
    assert.equal((await chat.attachTaskId(first.id, 'task-01', principal)).replayed, true);
    await assert.rejects(
      () => chat.attachTaskId(first.id, 'task-02', principal),
      error => error.code === 'OWNER_CHAT_TASK_LINK_CONFLICT'
    );

    const assistant = await chat.appendAssistantForTask({
      id: 'assistant-01',
      role: 'assistant',
      content: 'Verified answer',
      taskId: 'task-01',
      createdAt: new Date(baseTime + 500).toISOString()
    }, principal);
    assert.equal(assistant.skipped, false);
    assert.equal(assistant.message.content, 'Verified answer');

    for (let index = 2; index <= 4; index += 1) {
      await chat.append({
        id: 'message-0' + index,
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: 'Owner chat message ' + index,
        createdAt: new Date(baseTime + index * 1000).toISOString()
      }, principal);
    }

    // Identical message identifiers remain independent across tenant and owner boundaries.
    await otherTenant.append({ ...first, content: 'Other tenant message' }, otherTenantPrincipal);
    await otherOwner.append({ ...first, content: 'Other owner message' }, otherOwnerPrincipal);

    const history = await chat.list(principal);
    assert.equal(history.length, 3);
    assert.deepEqual(history.map(message => message.id), ['message-02', 'message-03', 'message-04']);
    assert.equal((await otherTenant.list(otherTenantPrincipal))[0].content, 'Other tenant message');
    assert.equal((await otherOwner.list(otherOwnerPrincipal))[0].content, 'Other owner message');

    const restarted = new PostgresOwnerChatConversationRepository(persistence.db, { maxMessages: 3 });
    assert.deepEqual(await restarted.list(principal), history);
  } finally {
    await chat.clear(principal);
    await otherOwner.clear(otherOwnerPrincipal);
    await otherTenant.clear(otherTenantPrincipal);
  }
});


test('PostgreSQL owner work profile requires a validated principal and isolates tenant and owner scopes', async () => {
  const suffix = randomUUID();
  const tenantId = 'tenant-owner-profile-' + suffix;
  const ownerId = 'owner-profile-test-' + suffix;
  const otherOwnerId = ownerId + '-other';
  const principal = makeOwnerPrincipal(tenantId, ownerId);
  const otherOwnerPrincipal = makeOwnerPrincipal(tenantId, otherOwnerId);
  const otherTenantPrincipal = makeOwnerPrincipal(tenantId + '-other', ownerId);
  const profile = new PostgresOwnerWorkProfileRepository(persistence.db);
  const other = new PostgresOwnerWorkProfileRepository(persistence.db);
  const otherTenant = new PostgresOwnerWorkProfileRepository(persistence.db);

  await assert.rejects(
    () => profile.get({ tenantId, ownerId, sessionId: 'forged-session' }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_REQUIRED'
  );

  try {
    assert.deepEqual(await profile.get(principal), {
      version: 1,
      mode: 'standard',
      workingPreferences: '',
      updatedAt: null
    });

    const saved = await profile.update({
      mode: 'plan-only',
      workingPreferences: 'Inspect evidence, define acceptance criteria, test before merging.'
    }, principal);
    assert.equal(saved.mode, 'plan-only');
    assert.equal(saved.workingPreferences, 'Inspect evidence, define acceptance criteria, test before merging.');
    assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));

    const partial = await profile.update({ workingPreferences: 'Updated preference' }, principal);
    assert.equal(partial.mode, 'plan-only');
    assert.equal(partial.workingPreferences, 'Updated preference');
    assert.ok(Date.parse(partial.updatedAt) >= Date.parse(saved.updatedAt));

    const restarted = new PostgresOwnerWorkProfileRepository(persistence.db);
    assert.deepEqual(await restarted.get(principal), partial);
    assert.equal((await other.get(otherOwnerPrincipal)).mode, 'standard');
    assert.equal((await other.get(otherOwnerPrincipal)).workingPreferences, '');
    assert.equal((await otherTenant.get(otherTenantPrincipal)).mode, 'standard');

    await assert.rejects(
      () => profile.update({ mode: 'owner-admin' }, principal),
      error => error.code === 'OWNER_PROFILE_MODE_INVALID'
    );
    await assert.rejects(
      () => profile.update({ workingPreferences: 'x'.repeat(4001) }, principal),
      error => error.code === 'OWNER_PROFILE_PREFERENCES_INVALID'
    );
  } finally {
    await pool.query(
      'DELETE FROM owner_work_profiles WHERE (tenant_id, owner_id) IN (($1,$2),($3,$4))',
      [tenantId, ownerId, tenantId, otherOwnerId]
    );
    await pool.query(
      'DELETE FROM owner_work_profiles WHERE tenant_id=$1 AND owner_id=$2',
      [tenantId + '-other', ownerId]
    );
  }
});


test('PostgreSQL principal transaction context is isolated across concurrent pooled connections', async () => {
  const suffix = randomUUID();
  const first = makeOwnerPrincipal('tenant-context-a-' + suffix, 'owner-context-a');
  const second = makeOwnerPrincipal('tenant-context-b-' + suffix, 'owner-context-b');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const observations = await Promise.all([first, second].map(principal =>
    persistence.db.transactionWithPrincipal(principal, async client => {
      const initial = await client.query(
        `SELECT current_setting('app.orient_tenant_id', true) AS tenant_id,
                current_setting('app.orient_owner_id', true) AS owner_id,
                current_setting('app.orient_session_id', true) AS session_id`
      );
      await delay(30);
      const later = await client.query(
        `SELECT current_setting('app.orient_tenant_id', true) AS tenant_id,
                current_setting('app.orient_owner_id', true) AS owner_id,
                current_setting('app.orient_session_id', true) AS session_id`
      );
      return { initial: initial.rows[0], later: later.rows[0], principal };
    })
  ));

  for (const item of observations) {
    assert.equal(item.initial.tenant_id, item.principal.tenantId);
    assert.equal(item.initial.owner_id, item.principal.ownerId);
    assert.equal(item.initial.session_id, item.principal.sessionId);
    assert.deepEqual(item.later, item.initial);
  }

  const reused = await pool.query(
    `SELECT current_setting('app.orient_tenant_id', true) AS tenant_id,
            current_setting('app.orient_owner_id', true) AS owner_id,
            current_setting('app.orient_session_id', true) AS session_id`
  );
  assert.ok(!reused.rows[0].tenant_id, 'transaction-local tenant context must not leak to a reused pool connection');
  assert.ok(!reused.rows[0].owner_id, 'transaction-local owner context must not leak to a reused pool connection');
  assert.ok(!reused.rows[0].session_id, 'transaction-local session context must not leak to a reused pool connection');
});


test('PostgreSQL approval lifecycle isolates two owners and serializes competing decisions', async t => {
  const tenantId = 'tenant-owner-approval-' + randomUUID();
  const ownerA = 'owner-a-' + randomUUID();
  const ownerB = 'owner-b-' + randomUUID();
  const executionA = 'execution-owner-a-' + randomUUID();
  const executionB = 'execution-owner-b-' + randomUUID();
  const principalA = makeOwnerPrincipal(tenantId, ownerA);
  const principalB = makeOwnerPrincipal(tenantId, ownerB);
  const approvalAId = 'approval-owner-a-' + randomUUID();
  const approvalBId = 'approval-owner-b-' + randomUUID();

  t.after(async () => {
    await pool.query('DELETE FROM approvals WHERE tenant_id=$1 AND approval_id = ANY($2::text[])', [
      tenantId, [approvalAId, approvalBId]
    ]);
    await pool.query('DELETE FROM executions WHERE tenant_id=$1 AND execution_id = ANY($2::text[])', [
      tenantId, [executionA, executionB]
    ]);
  });

  await persistence.executions.insert({
    executionId: executionA,
    tenantId,
    userId: ownerA,
    status: 'running'
  }, { tenantId });
  await persistence.executions.insert({
    executionId: executionB,
    tenantId,
    userId: ownerB,
    status: 'running'
  }, { tenantId });

  const baseApproval = executionId => ({
    executionId,
    tenantId,
    step: 1,
    planRevision: 1,
    tool: 'memory.read',
    capability: 'memory:read',
    scope: {},
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    used: false,
    metadata: { tenantId }
  });
  await persistence.approvals.save({
    ...baseApproval(executionA), approvalId: approvalAId
  }, { tenantId, persistencePrincipal: principalA });
  await persistence.approvals.save({
    ...baseApproval(executionB), approvalId: approvalBId
  }, { tenantId, persistencePrincipal: principalB });

  const ownerARecord = await persistence.approvals.findById(approvalAId, {
    tenantId, persistencePrincipal: principalA
  });
  const ownerBCannotReadA = await persistence.approvals.findById(approvalAId, {
    tenantId, persistencePrincipal: principalB
  });
  assert.equal(ownerARecord?.approvalId, approvalAId);
  assert.equal(ownerBCannotReadA, null);

  const ownerAPending = await persistence.approvals.findPending({
    tenantId, persistencePrincipal: principalA, now: Date.now()
  });
  const ownerBPending = await persistence.approvals.findPending({
    tenantId, persistencePrincipal: principalB, now: Date.now()
  });
  assert.deepEqual(ownerAPending.map(item => item.approvalId), [approvalAId]);
  assert.deepEqual(ownerBPending.map(item => item.approvalId), [approvalBId]);

  const makeApprovalService = () => new ApprovalService({
    repository: persistence.approvals,
    tenantId,
    decisionAuthorizer: async ({ actorId }) =>
      actorId === principalA.sessionId || actorId === principalB.sessionId
  });
  const serviceA = makeApprovalService();
  const serviceB = makeApprovalService();

  await assert.rejects(
    serviceA.decide({
      approvalId: approvalBId,
      executionId: executionB,
      decision: 'approved',
      actorId: principalA.sessionId,
      tenantId,
      persistencePrincipal: principalA
    }),
    error => error.code === 'APPROVAL_NOT_FOUND'
  );

  const competing = await Promise.allSettled([
    serviceA.decide({
      approvalId: approvalAId,
      executionId: executionA,
      decision: 'approved',
      actorId: principalA.sessionId,
      tenantId,
      persistencePrincipal: principalA
    }),
    serviceB.decide({
      approvalId: approvalAId,
      executionId: executionA,
      decision: 'rejected',
      actorId: principalA.sessionId,
      tenantId,
      persistencePrincipal: principalA
    })
  ]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competing.filter(result => result.status === 'rejected').length, 1);
  const durable = await persistence.approvals.findById(approvalAId, {
    tenantId, persistencePrincipal: principalA
  });
  assert.ok(['approved', 'rejected'].includes(durable.decision?.status));

  const wrongOwnerConsume = await persistence.approvals.consume(
    approvalAId,
    new Date().toISOString(),
    tenantId,
    { persistencePrincipal: principalB }
  );
  assert.equal(wrongOwnerConsume, false);

});


test('PostgreSQL worker registry fences replaced process sessions', async t => {
  const tenantId = 'tenant-worker-session-' + randomUUID();
  const workerId = 'worker-session-' + randomUUID();
  const principalA = makeWorkerPrincipal(tenantId, workerId);
  const principalB = makeWorkerPrincipal(tenantId, workerId);
  const registration = principal => ({
    workerId,
    tenantId,
    status: 'READY',
    capabilities: [],
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    metadata: {}
  });

  t.after(async () => {
    await pool.query('DELETE FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2', [tenantId, workerId]);
  });

  await persistence.workers.register(registration(principalA), tenantId, {
    workerPrincipal: principalA
  });
  await assert.rejects(
    persistence.workers.register(registration(principalB), tenantId, {
      workerPrincipal: principalB
    }),
    error => error.code === 'WORKER_SESSION_CONFLICT'
  );
  await assert.rejects(
    persistence.workers.heartbeat(workerId, {
      tenantId,
      workerPrincipal: principalB
    }),
    error => error.code === 'WORKER_SESSION_LOST'
  );

  await persistence.workers.heartbeat(workerId, {
    tenantId,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    workerPrincipal: principalA
  });
  await pool.query(
    "UPDATE worker_nodes SET expires_at=NOW()-INTERVAL '1 second' WHERE tenant_id=$1 AND worker_id=$2",
    [tenantId, workerId]
  );
  await persistence.workers.register(registration(principalB), tenantId, {
    workerPrincipal: principalB
  });
  await assert.rejects(
    persistence.workers.heartbeat(workerId, {
      tenantId,
      workerPrincipal: principalA
    }),
    error => error.code === 'WORKER_SESSION_LOST'
  );
  await persistence.workers.heartbeat(workerId, {
    tenantId,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    workerPrincipal: principalB
  });
  assert.equal(await persistence.workers.unregister(workerId, tenantId, {
    workerPrincipal: principalA
  }), false);
  assert.equal(await persistence.workers.unregister(workerId, tenantId, {
    workerPrincipal: principalB
  }), true);
});
