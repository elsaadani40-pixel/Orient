const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const {
  PostgresPersistence
} = require('../../src/infrastructure/persistence/postgres/postgres-persistence');
const {
  createWorkerPersistencePrincipal
} = require('../../src/core/security/worker-persistence-principal');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = new PostgresPersistence({ pool });

function workerPrincipal(tenantId, workerId) {
  return createWorkerPersistencePrincipal({
    tenantId,
    workerId,
    sessionId: 'session-' + randomUUID(),
    capabilities: []
  });
}

async function withRegisteredQueuedWorkflow(scenario, run) {
  await persistence.initialize();
  const tenantId = 'tenant-' + scenario + '-' + randomUUID();
  const workflowId = 'workflow-' + scenario + '-' + randomUUID();
  const worker = workerPrincipal(tenantId, 'worker-' + scenario + '-' + randomUUID());
  try {
    await pool.query(
      'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,$2,$3,clock_timestamp(),$4)',
      [workflowId, tenantId, 'QUEUED', { workflowId, tenantId, state: 'QUEUED', metadata: {} }]
    );
    await persistence.workers.register({
      workerId: worker.workerId, tenantId, status: 'READY', capabilities: [],
      heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
    }, tenantId, { workerPrincipal: worker });
    return await run({ tenantId, workflowId, worker });
  } finally {
    await pool.query('DELETE FROM workflow_dispatch_claims WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
    await pool.query('DELETE FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
    await pool.query('DELETE FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2', [tenantId, worker.workerId]);
    await pool.query('DELETE FROM workflows WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
  }
}

async function assertWriteRejectedAfterFenceExpiresWhileWorkflowLockHeld({
  scenario,
  expectedCode,
  expireFence
}) {
  await persistence.initialize();

  const tenantId = 'tenant-' + scenario + '-' + randomUUID();
  const workflowId = 'workflow-' + scenario + '-' + randomUUID();
  const worker = workerPrincipal(tenantId, 'worker-' + scenario + '-' + randomUUID());
  const blocker = await pool.connect();
  let blockerInTransaction = false;
  let savePromise = null;

  await pool.query(
    'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,$2,$3,NOW(),$4)',
    [workflowId, tenantId, 'QUEUED', { workflowId, tenantId, state: 'QUEUED', metadata: {} }]
  );

  try {
    await persistence.workers.register({
      workerId: worker.workerId,
      tenantId,
      status: 'READY',
      capabilities: [],
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    }, tenantId, { workerPrincipal: worker });

    const lease = await persistence.workflowLeases.tryAcquire({
      workflowId,
      leaseId: 'lease-' + scenario + '-' + randomUUID(),
      workerId: worker.workerId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30000,
      metadata: { tenantId }
    }, tenantId, { workerPrincipal: worker });

    const leasePrincipal = createWorkerPersistencePrincipal({
      tenantId,
      workerId: worker.workerId,
      sessionId: worker.sessionId,
      capabilities: worker.capabilities,
      workflowId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken
    });

    await expireFence({ tenantId, workflowId, worker });
    await blocker.query('BEGIN');
    blockerInTransaction = true;
    await blocker.query(
      'SELECT workflow_id FROM workflows WHERE workflow_id=$1 AND tenant_id=$2 FOR UPDATE',
      [workflowId, tenantId]
    );

    savePromise = persistence.workflows.save({
      workflowId,
      tenantId,
      state: 'RUNNING',
      updatedAt: new Date().toISOString(),
      metadata: { fencingToken: lease.fencingToken }
    }, tenantId, { workerPrincipal: leasePrincipal });

    let waiting = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const activity = await pool.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname=current_database()
           AND wait_event_type='Lock'
           AND query LIKE 'SELECT workflow_id FROM workflows%'
         LIMIT 1`
      );
      if (activity.rowCount === 1) {
        waiting = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(waiting, true, 'worker persistence must be waiting on the held workflow row lock');

    await blocker.query('SELECT pg_sleep(2.3)');
    await blocker.query('COMMIT');
    blockerInTransaction = false;

    await assert.rejects(savePromise, error => error.code === expectedCode);
  } finally {
    if (blockerInTransaction) await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    if (savePromise) await savePromise.catch(() => {});
    await pool.query('DELETE FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
    await pool.query('DELETE FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2', [tenantId, worker.workerId]);
    await pool.query('DELETE FROM workflows WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
  }
}

test('PostgreSQL rejects a stale mission-event append racing with expired lease reacquisition', async t => {
  await persistence.initialize();

  const tenantId = 'tenant-mission-fence-' + randomUUID();
  const workflowId = 'workflow-mission-fence-' + randomUUID();
  const workerA = workerPrincipal(tenantId, 'worker-a-' + randomUUID());
  const workerB = workerPrincipal(tenantId, 'worker-b-' + randomUUID());
  let leaseB = null;

  await pool.query(
    'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,$2,$3,NOW(),$4)',
    [workflowId, tenantId, 'QUEUED', { workflowId, tenantId, state: 'QUEUED', metadata: {} }]
  );

  try {
    for (const principal of [workerA, workerB]) {
      await persistence.workers.register({
        workerId: principal.workerId,
        tenantId,
        status: 'READY',
        capabilities: [],
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString()
      }, tenantId, { workerPrincipal: principal });
    }

    const leaseA = await persistence.workflowLeases.tryAcquire({
      workflowId,
      leaseId: 'lease-a-' + randomUUID(),
      workerId: workerA.workerId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30000,
      metadata: { tenantId }
    }, tenantId, { workerPrincipal: workerA });

    const stalePrincipal = createWorkerPersistencePrincipal({
      tenantId,
      workerId: workerA.workerId,
      sessionId: workerA.sessionId,
      capabilities: workerA.capabilities,
      workflowId,
      leaseId: leaseA.leaseId,
      fencingToken: leaseA.fencingToken
    });

    await pool.query(
      "UPDATE workflow_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE workflow_id=$1 AND tenant_id=$2",
      [workflowId, tenantId]
    );

    const staleEventId = 'stale-event-' + randomUUID();
    const takeover = await Promise.allSettled([
      persistence.workflowLeases.tryAcquire({
        workflowId,
        leaseId: 'lease-b-' + randomUUID(),
        workerId: workerB.workerId,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 30000,
        metadata: { tenantId }
      }, tenantId, { workerPrincipal: workerB }),
      persistence.events.appendMissionEvent({
        id: staleEventId,
        aggregateId: workflowId,
        executionId: workflowId,
        type: 'workflow.step.completed',
        timestamp: new Date().toISOString(),
        data: { tenantId, stepId: 'stale-step' }
      }, { tenantId, workerPrincipal: stalePrincipal })
    ]);

    assert.equal(takeover[0].status, 'fulfilled');
    leaseB = takeover[0].value;
    assert.ok(leaseB.fencingToken > leaseA.fencingToken);
    assert.equal(takeover[1].status, 'rejected');
    assert.equal(takeover[1].reason.code, 'WORKFLOW_FENCING_REJECTED');

    const currentPrincipal = createWorkerPersistencePrincipal({
      tenantId,
      workerId: workerB.workerId,
      sessionId: workerB.sessionId,
      capabilities: workerB.capabilities,
      workflowId,
      leaseId: leaseB.leaseId,
      fencingToken: leaseB.fencingToken
    });
    const currentEventId = 'current-event-' + randomUUID();

    const appended = await persistence.events.appendMissionEvent({
      id: currentEventId,
      aggregateId: workflowId,
      executionId: workflowId,
      type: 'workflow.step.completed',
      timestamp: new Date().toISOString(),
      data: { tenantId, stepId: 'current-step' }
    }, { tenantId, workerPrincipal: currentPrincipal });

    assert.equal(appended.id, currentEventId);
    const history = await persistence.events.findByAggregateId(workflowId, { tenantId });
    assert.equal(history.some(event => event.id === staleEventId), false);
    assert.equal(history.some(event => event.id === currentEventId), true);
  } finally {
    if (leaseB) {
      const currentPrincipal = createWorkerPersistencePrincipal({
        tenantId,
        workerId: workerB.workerId,
        sessionId: workerB.sessionId,
        capabilities: workerB.capabilities,
        workflowId,
        leaseId: leaseB.leaseId,
        fencingToken: leaseB.fencingToken
      });
      await persistence.workflowLeases.delete(workflowId, leaseB.leaseId, tenantId, {
        workerPrincipal: currentPrincipal
      }).catch(() => {});
    }
    await pool.query('DELETE FROM events WHERE tenant_id=$1 AND aggregate_id=$2', [tenantId, workflowId]);
    await pool.query('DELETE FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
    await persistence.workers.unregister(workerA.workerId, tenantId, { workerPrincipal: workerA }).catch(() => {});
    await persistence.workers.unregister(workerB.workerId, tenantId, { workerPrincipal: workerB }).catch(() => {});
    await pool.query('DELETE FROM workflows WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
  }
});

test('PostgreSQL rejects a workflow write when its lease expires while the writer waits for the workflow lock', async () => {
  await assertWriteRejectedAfterFenceExpiresWhileWorkflowLockHeld({
    scenario: 'workflow-expiry',
    expectedCode: 'WORKFLOW_FENCING_REJECTED',
    async expireFence({ tenantId, workflowId }) {
      await pool.query(
        "UPDATE workflow_leases SET expires_at=clock_timestamp()+INTERVAL '500 milliseconds' WHERE workflow_id=$1 AND tenant_id=$2",
        [workflowId, tenantId]
      );
    }
  });
});

test('PostgreSQL rejects a workflow write when the worker session expires while waiting for the workflow lock', async () => {
  await assertWriteRejectedAfterFenceExpiresWhileWorkflowLockHeld({
    scenario: 'session-expiry',
    expectedCode: 'WORKER_SESSION_LOST',
    async expireFence({ tenantId, worker }) {
      await pool.query(
        "UPDATE worker_nodes SET expires_at=clock_timestamp()+INTERVAL '2 seconds' WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3",
        [tenantId, worker.workerId, worker.sessionId]
      );
    }
  });
});

test('PostgreSQL atomically converts an exact dispatch claim into one durable worker lease', async () => {
  await withRegisteredQueuedWorkflow('atomic-handoff', async ({ tenantId, workflowId, worker }) => {
    const [claimed] = await persistence.workflows.claimQueued({
      tenantId, workerId: worker.workerId, limit: 1, claimTtlMs: 10000,
      workerCapabilities: [], workerPrincipal: worker
    });
    assert.ok(claimed?.dispatchClaim, 'claim response must include exact durable identity');
    assert.equal(claimed.dispatchClaim.workerSessionId, worker.sessionId);
    const lease = await persistence.workflowLeases.tryAcquireClaimed({
      workflowId, leaseId: 'lease-' + randomUUID(), workerId: worker.workerId,
      acquiredAt: Date.now(), expiresAt: Date.now() + 30000, metadata: { tenantId }
    }, claimed.dispatchClaim, tenantId, { workerPrincipal: worker });
    assert.ok(Number.isSafeInteger(lease.fencingToken) && lease.fencingToken > 0);
    const state = await pool.query(
      'SELECT (SELECT COUNT(*)::int FROM workflow_dispatch_claims WHERE tenant_id=$1 AND workflow_id=$2) AS claims, (SELECT COUNT(*)::int FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2 AND lease_id=$3) AS leases',
      [tenantId, workflowId, lease.leaseId]
    );
    assert.equal(state.rows[0].claims, 0);
    assert.equal(state.rows[0].leases, 1);
  });
});

test('PostgreSQL rejects a replaced dispatch claim without creating a lease', async () => {
  await withRegisteredQueuedWorkflow('replaced-claim', async ({ tenantId, workflowId, worker }) => {
    const [claimed] = await persistence.workflows.claimQueued({
      tenantId, workerId: worker.workerId, limit: 1, claimTtlMs: 10000,
      workerCapabilities: [], workerPrincipal: worker
    });
    await pool.query(
      "UPDATE workflow_dispatch_claims SET claimed_at=claimed_at-INTERVAL '1 millisecond' WHERE tenant_id=$1 AND workflow_id=$2",
      [tenantId, workflowId]
    );
    await assert.rejects(() => persistence.workflowLeases.tryAcquireClaimed({
      workflowId, leaseId: 'lease-' + randomUUID(), workerId: worker.workerId,
      acquiredAt: Date.now(), expiresAt: Date.now() + 30000, metadata: { tenantId }
    }, claimed.dispatchClaim, tenantId, { workerPrincipal: worker }), error => error.code === 'WORKFLOW_DISPATCH_CLAIM_INVALID');
    const leaseCount = await pool.query(
      'SELECT COUNT(*)::int AS count FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2',
      [tenantId, workflowId]
    );
    assert.equal(leaseCount.rows[0].count, 0);
  });
});

test.after(async () => {
  await pool.end();
});
