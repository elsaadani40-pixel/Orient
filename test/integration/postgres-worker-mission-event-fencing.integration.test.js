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
const AsyncWorkflowLeaseStore = require('../../src/core/workflow/async-workflow-lease-store');

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

async function withRegisteredQueuedWorkflow(scenario, run, workerCount = 1) {
  await persistence.initialize();
  const tenantId = 'tenant-' + scenario + '-' + randomUUID();
  const workflowId = 'workflow-' + scenario + '-' + randomUUID();
  const workers = Array.from({ length: workerCount }, (_, index) =>
    workerPrincipal(tenantId, 'worker-' + scenario + '-' + index + '-' + randomUUID())
  );
  try {
    await pool.query(
      'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES ($1,$2,$3,clock_timestamp(),$4)',
      [workflowId, tenantId, 'QUEUED', { workflowId, tenantId, state: 'QUEUED', metadata: {} }]
    );
    for (const worker of workers) {
      await persistence.workers.register({
        workerId: worker.workerId, tenantId, status: 'READY', capabilities: [],
        heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()
      }, tenantId, { workerPrincipal: worker });
    }
    return await run({ tenantId, workflowId, worker: workers[0], workers });
  } finally {
    await pool.query('DELETE FROM workflow_dispatch_claims WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
    await pool.query('DELETE FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
    for (const worker of workers) {
      await pool.query('DELETE FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2', [tenantId, worker.workerId]);
    }
    await pool.query('DELETE FROM workflows WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
  }
}

async function claimQueuedWorkflow({ tenantId, worker, claimTtlMs = 10000 }) {
  const [claimed] = await persistence.workflows.claimQueued({
    tenantId, workerId: worker.workerId, limit: 1, claimTtlMs,
    workerCapabilities: [], workerPrincipal: worker
  });
  assert.ok(claimed?.dispatchClaim, 'claim response must include exact durable identity');
  return claimed;
}

async function acquireClaimedWorkflowLease({ tenantId, workflowId, worker, claim, leaseId = 'lease-' + randomUUID() }) {
  return persistence.workflowLeases.tryAcquireClaimed({
    workflowId, leaseId, workerId: worker.workerId,
    acquiredAt: Date.now(), expiresAt: Date.now() + 30000, metadata: { tenantId }
  }, claim, tenantId, { workerPrincipal: worker });
}

async function assertWriteRejectedAfterFenceExpiresWhileWorkflowLockHeld({
  scenario,
  expectedCode,
  expireFence
}) {
  await withRegisteredQueuedWorkflow(scenario, async ({ tenantId, workflowId, worker }) => {
    const blocker = await pool.connect();
    let blockerInTransaction = false;
    let savePromise = null;
    try {
      const lease = await persistence.workflowLeases.tryAcquire({
        workflowId, leaseId: 'lease-' + scenario + '-' + randomUUID(), workerId: worker.workerId,
        acquiredAt: Date.now(), expiresAt: Date.now() + 30000, metadata: { tenantId }
      }, tenantId, { workerPrincipal: worker });
      const leasePrincipal = createWorkerPersistencePrincipal({
        tenantId, workerId: worker.workerId, sessionId: worker.sessionId,
        capabilities: worker.capabilities, workflowId, leaseId: lease.leaseId,
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
        workflowId, tenantId, state: 'RUNNING', updatedAt: new Date().toISOString(),
        metadata: { fencingToken: lease.fencingToken }
      }, tenantId, { workerPrincipal: leasePrincipal });
      let waiting = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const activity = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event_type='Lock'
             AND query LIKE 'SELECT workflow_id FROM workflows%' LIMIT 1`
        );
        if (activity.rowCount === 1) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(waiting, true, 'worker persistence must wait on the held workflow row lock');
      await blocker.query('SELECT pg_sleep(2.3)');
      await blocker.query('COMMIT');
      blockerInTransaction = false;
      await assert.rejects(savePromise, error => error.code === expectedCode);
    } finally {
      if (blockerInTransaction) await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      if (savePromise) await savePromise.catch(() => {});
    }
  });
}

test('PostgreSQL rejects a stale mission-event append racing with expired lease reacquisition', async () => {
  await withRegisteredQueuedWorkflow('mission-fence', async ({ tenantId, workflowId, workers }) => {
    const [workerA, workerB] = workers;
    let leaseB = null;
    try {
      const leaseA = await persistence.workflowLeases.tryAcquire({
        workflowId, leaseId: 'lease-a-' + randomUUID(), workerId: workerA.workerId,
        acquiredAt: Date.now(), expiresAt: Date.now() + 30000, metadata: { tenantId }
      }, tenantId, { workerPrincipal: workerA });
      const stalePrincipal = createWorkerPersistencePrincipal({
        tenantId, workerId: workerA.workerId, sessionId: workerA.sessionId,
        capabilities: workerA.capabilities, workflowId, leaseId: leaseA.leaseId,
        fencingToken: leaseA.fencingToken
      });
      await pool.query(
        "UPDATE workflow_leases SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE workflow_id=$1 AND tenant_id=$2",
        [workflowId, tenantId]
      );
      const staleEventId = 'stale-event-' + randomUUID();
      const takeover = await Promise.allSettled([
        persistence.workflowLeases.tryAcquire({
          workflowId, leaseId: 'lease-b-' + randomUUID(), workerId: workerB.workerId,
          acquiredAt: Date.now(), expiresAt: Date.now() + 30000, metadata: { tenantId }
        }, tenantId, { workerPrincipal: workerB }),
        persistence.events.appendMissionEvent({
          id: staleEventId, aggregateId: workflowId, executionId: workflowId,
          type: 'workflow.step.completed', timestamp: new Date().toISOString(),
          data: { tenantId, stepId: 'stale-step' }
        }, { tenantId, workerPrincipal: stalePrincipal })
      ]);
      assert.equal(takeover[0].status, 'fulfilled');
      leaseB = takeover[0].value;
      assert.ok(leaseB.fencingToken > leaseA.fencingToken);
      assert.equal(takeover[1].status, 'rejected');
      assert.equal(takeover[1].reason.code, 'WORKFLOW_FENCING_REJECTED');
      const currentPrincipal = createWorkerPersistencePrincipal({
        tenantId, workerId: workerB.workerId, sessionId: workerB.sessionId,
        capabilities: workerB.capabilities, workflowId, leaseId: leaseB.leaseId,
        fencingToken: leaseB.fencingToken
      });
      const currentEventId = 'current-event-' + randomUUID();
      const appended = await persistence.events.appendMissionEvent({
        id: currentEventId, aggregateId: workflowId, executionId: workflowId,
        type: 'workflow.step.completed', timestamp: new Date().toISOString(),
        data: { tenantId, stepId: 'current-step' }
      }, { tenantId, workerPrincipal: currentPrincipal });
      assert.equal(appended.id, currentEventId);
      const history = await persistence.events.findByAggregateId(workflowId, { tenantId });
      assert.equal(history.some(event => event.id === staleEventId), false);
      assert.equal(history.some(event => event.id === currentEventId), true);
    } finally {
      if (leaseB) {
        const currentPrincipal = createWorkerPersistencePrincipal({
          tenantId, workerId: workerB.workerId, sessionId: workerB.sessionId,
          capabilities: workerB.capabilities, workflowId, leaseId: leaseB.leaseId,
          fencingToken: leaseB.fencingToken
        });
        await persistence.workflowLeases.delete(workflowId, leaseB.leaseId, tenantId, { workerPrincipal: currentPrincipal }).catch(() => {});
      }
      await pool.query('DELETE FROM events WHERE tenant_id=$1 AND aggregate_id=$2', [tenantId, workflowId]);
    }
  }, 2);
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
    const claimed = await claimQueuedWorkflow({ tenantId, worker });
    assert.ok(claimed?.dispatchClaim, 'claim response must include exact durable identity');
    assert.equal(claimed.dispatchClaim.workerSessionId, worker.sessionId);
    const lease = await acquireClaimedWorkflowLease({ tenantId, workflowId, worker, claim: claimed.dispatchClaim });
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
    const claimed = await claimQueuedWorkflow({ tenantId, worker });
    await pool.query(
      "UPDATE workflow_dispatch_claims SET claimed_at=claimed_at-INTERVAL '1 millisecond' WHERE tenant_id=$1 AND workflow_id=$2",
      [tenantId, workflowId]
    );
    await assert.rejects(() => acquireClaimedWorkflowLease({ tenantId, workflowId, worker, claim: claimed.dispatchClaim }), error => error.code === 'WORKFLOW_DISPATCH_CLAIM_INVALID');
    const leaseCount = await pool.query(
      'SELECT COUNT(*)::int AS count FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2',
      [tenantId, workflowId]
    );
    assert.equal(leaseCount.rows[0].count, 0);
  });
});

test('PostgreSQL rolls back claim consumption when durable lease insertion fails', async () => {
  await withRegisteredQueuedWorkflow('handoff-rollback', async ({ tenantId, workflowId, worker }) => {
    const claimed = await claimQueuedWorkflow({ tenantId, worker });
    const duplicateLeaseId = 'lease-duplicate-' + randomUUID();
    const conflictWorkflowId = 'workflow-lease-conflict-' + randomUUID();
    try {
      await pool.query(
        'INSERT INTO workflow_leases(workflow_id,tenant_id,lease_id,worker_id,worker_session_id,acquired_at,expires_at,payload) VALUES ($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+INTERVAL \'30 seconds\',$6)',
        [conflictWorkflowId, tenantId, duplicateLeaseId, worker.workerId, worker.sessionId, { workflowId: conflictWorkflowId, tenantId }]
      );
      await assert.rejects(() => acquireClaimedWorkflowLease({ tenantId, workflowId, worker, claim: claimed.dispatchClaim, leaseId: duplicateLeaseId }), error => error.code === '23505');
      const state = await pool.query(
        'SELECT (SELECT COUNT(*)::int FROM workflow_dispatch_claims WHERE tenant_id=$1 AND workflow_id=$2) AS claims, (SELECT COUNT(*)::int FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2) AS leases',
        [tenantId, workflowId]
      );
      assert.equal(state.rows[0].claims, 1, 'claim must remain after the failed lease insert transaction rolls back');
      assert.equal(state.rows[0].leases, 0, 'failed lease insert must not leave a partial lease');
    } finally {
      await pool.query('DELETE FROM workflow_leases WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, conflictWorkflowId]);
    }
  });
});


test('PostgreSQL lease state survives scheduler-process reconstruction and fences the stale worker after expiry takeover', async () => {
  await withRegisteredQueuedWorkflow('process-restart-recovery', async ({ tenantId, workflowId, workers }) => {
    const [workerA, workerB] = workers;
    const leaseA = await persistence.workflowLeases.tryAcquire({
      workflowId, leaseId: 'lease-a-' + randomUUID(), workerId: workerA.workerId,
      acquiredAt: Date.now(), expiresAt: Date.now() + 30000, metadata: { tenantId }
    }, tenantId, { workerPrincipal: workerA });
    const stalePrincipal = createWorkerPersistencePrincipal({
      tenantId, workerId: workerA.workerId, sessionId: workerA.sessionId,
      capabilities: workerA.capabilities, workflowId, leaseId: leaseA.leaseId,
      fencingToken: leaseA.fencingToken
    });

    // A new store instance has no process-local memory: it must recover the
    // authoritative lease exclusively from PostgreSQL.
    const restartedStore = new AsyncWorkflowLeaseStore({
      repository: persistence.workflowLeases, tenantId, leaseDurationMs: 30000
    });
    const restored = await restartedStore.get(workflowId);
    assert.equal(restored.leaseId, leaseA.leaseId);
    assert.equal(restored.fencingToken, leaseA.fencingToken);

    const competingStore = new AsyncWorkflowLeaseStore({
      repository: persistence.workflowLeases, tenantId, leaseDurationMs: 30000
    });
    await assert.rejects(
      () => competingStore.acquire(workflowId, workerB.workerId, { tenantId }, workerB),
      error => error.code === 'WORKFLOW_LEASE_HELD'
    );

    // Expire through database time, then let a fresh process perform recovery.
    await pool.query(
      "UPDATE workflow_leases SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE tenant_id=$1 AND workflow_id=$2 AND lease_id=$3",
      [tenantId, workflowId, leaseA.leaseId]
    );
    const recovered = await restartedStore.recoverExpired();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].leaseId, leaseA.leaseId);

    const leaseB = await competingStore.acquire(
      workflowId, workerB.workerId, { tenantId }, workerB
    );
    assert.ok(leaseB.fencingToken > leaseA.fencingToken);

    await assert.rejects(
      () => persistence.workflows.save({
        workflowId, tenantId, state: 'RUNNING', updatedAt: new Date().toISOString(),
        metadata: { fencingToken: leaseA.fencingToken }
      }, tenantId, { workerPrincipal: stalePrincipal }),
      error => error.code === 'WORKFLOW_FENCING_REJECTED'
    );

    const currentPrincipal = createWorkerPersistencePrincipal({
      tenantId, workerId: workerB.workerId, sessionId: workerB.sessionId,
      capabilities: workerB.capabilities, workflowId, leaseId: leaseB.leaseId,
      fencingToken: leaseB.fencingToken
    });
    await persistence.workflowLeases.delete(
      workflowId, leaseB.leaseId, tenantId, { workerPrincipal: currentPrincipal }
    );
  }, 2);
});


test('PostgreSQL quota recovery and competing promotion converge after a concurrent capacity race', async () => {
  await persistence.initialize();
  const tenantId = 'tenant-quota-race-' + randomUUID();
  const expiredWorkflowId = 'workflow-expired-' + randomUUID();
  const competingWorkflowId = 'workflow-competing-' + randomUUID();
  const quotaRepository = persistence.tenantQuotas;
  const expiresAt = new Date(Date.now() + 60000).toISOString();

  try {
    await pool.query(
      'INSERT INTO tenant_quota_limits(tenant_id,max_concurrent,max_queued,max_input_chars,max_tool_input_chars,max_retries,updated_at) VALUES($1,1,10,10000,10000,3,clock_timestamp())',
      [tenantId]
    );
    for (const [workflowId, state] of [[expiredWorkflowId, 'RUNNING'], [competingWorkflowId, 'QUEUED']]) {
      await pool.query(
        'INSERT INTO workflows(workflow_id,tenant_id,state,updated_at,payload) VALUES($1,$2,$3,clock_timestamp(),$4)',
        [workflowId, tenantId, state, { workflowId, tenantId, state, metadata: {} }]
      );
    }
    await pool.query(
      "INSERT INTO tenant_quota_reservations(tenant_id,workflow_id,state,reserved_at,expires_at,fencing_token) VALUES($1,$2,'RUNNING',clock_timestamp()-INTERVAL '2 minutes',clock_timestamp()-INTERVAL '1 minute',41),($1,$3,'QUEUED',clock_timestamp(),NULL,NULL)",
      [tenantId, expiredWorkflowId, competingWorkflowId]
    );

    const [recovery, firstPromotion] = await Promise.allSettled([
      quotaRepository.recoverWorkflow({ tenantId, workflowId: expiredWorkflowId }),
      quotaRepository.promoteWorkflow({ tenantId, workflowId: competingWorkflowId, expiresAt, fencingToken: 9001 })
    ]);
    assert.equal(recovery.status, 'fulfilled');
    assert.equal(recovery.value.state, 'QUEUED');

    // Match AsyncWorkflowScheduler.recoverPersisted(): after converting an
    // expired RUNNING reservation back to QUEUED, reserve it again before
    // considering recovery complete. A competing promotion may have cleaned
    // up the expired queue row in the meantime.
    const recoveredReservation = await quotaRepository.reserveWorkflow({
      tenantId,
      workflowId: expiredWorkflowId,
      policy: {
        maxConcurrent: 1, maxQueued: 10, maxInputChars: 10000,
        maxToolInputChars: 10000, maxRetries: 3
      }
    });
    assert.equal(recoveredReservation.state, 'QUEUED');

    let promoted = firstPromotion;
    if (promoted.status === 'rejected') {
      assert.equal(promoted.reason.code, 'TENANT_CONCURRENT_QUOTA_EXCEEDED');
      // A promotion that wins the race before recovery may conservatively fail
      // once. It must succeed on retry after the expired reservation is repaired.
      promoted = { status: 'fulfilled', value: await quotaRepository.promoteWorkflow({
        tenantId, workflowId: competingWorkflowId, expiresAt, fencingToken: 9002
      }) };
    }
    assert.equal(promoted.status, 'fulfilled');
    assert.equal(promoted.value.state, 'RUNNING');

    const state = await pool.query(
      'SELECT workflow_id,state,fencing_token FROM tenant_quota_reservations WHERE tenant_id=$1 AND workflow_id=ANY($2::text[]) ORDER BY workflow_id',
      [tenantId, [expiredWorkflowId, competingWorkflowId]]
    );
    const byWorkflow = new Map(state.rows.map(row => [row.workflow_id, row]));
    assert.equal(byWorkflow.get(expiredWorkflowId).state, 'QUEUED');
    assert.equal(byWorkflow.get(competingWorkflowId).state, 'RUNNING');
    const active = await pool.query(
      "SELECT COUNT(*)::int AS count FROM tenant_quota_reservations WHERE tenant_id=$1 AND state='RUNNING'",
      [tenantId]
    );
    assert.equal(active.rows[0].count, 1);
  } finally {
    await pool.query('DELETE FROM tenant_quota_reservations WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM workflows WHERE tenant_id=$1 AND workflow_id=ANY($2::text[])', [tenantId, [expiredWorkflowId, competingWorkflowId]]);
    await pool.query('DELETE FROM tenant_quota_limits WHERE tenant_id=$1', [tenantId]);
  }
});

test('PostgreSQL does not dispatch a workflow for quota recovery while its durable lease is still live', async () => {
  await withRegisteredQueuedWorkflow('live-lease-quota-recovery', async ({ tenantId, workflowId, worker }) => {
    try {
      await pool.query(
        'INSERT INTO tenant_quota_limits(tenant_id,max_concurrent,max_queued,max_input_chars,max_tool_input_chars,max_retries,updated_at) VALUES($1,1,10,10000,10000,3,clock_timestamp())',
        [tenantId]
      );
      await pool.query(
        "INSERT INTO tenant_quota_reservations(tenant_id,workflow_id,state,reserved_at,expires_at,fencing_token) VALUES($1,$2,'RUNNING',clock_timestamp()-INTERVAL '2 minutes',clock_timestamp()-INTERVAL '1 minute',51)",
        [tenantId, workflowId]
      );
      const lease = await persistence.workflowLeases.tryAcquire({
        workflowId, leaseId: 'lease-live-quota-' + randomUUID(), workerId: worker.workerId,
        acquiredAt: Date.now(), expiresAt: Date.now() + 30000, metadata: { tenantId }
      }, tenantId, { workerPrincipal: worker });
      assert.ok(lease);

      const claimed = await persistence.workflows.claimQueued({
        tenantId, workerId: worker.workerId, limit: 1, claimTtlMs: 10000,
        workerCapabilities: [], workerPrincipal: worker
      });
      assert.equal(claimed.length, 0, 'an unexpired durable lease must prevent dispatch to the quota recovery path');

      const reservation = await pool.query(
        'SELECT state FROM tenant_quota_reservations WHERE tenant_id=$1 AND workflow_id=$2',
        [tenantId, workflowId]
      );
      assert.equal(reservation.rows[0].state, 'RUNNING',
        'the expired quota reservation remains untouched while the live lease blocks scheduler recovery');
    } finally {
      await pool.query('DELETE FROM tenant_quota_reservations WHERE tenant_id=$1 AND workflow_id=$2', [tenantId, workflowId]);
      await pool.query('DELETE FROM tenant_quota_limits WHERE tenant_id=$1', [tenantId]);
    }
  });
});


test('PostgreSQL rejects a worker heartbeat when its session expires while waiting for the registry row lock', async () => {
  await withRegisteredQueuedWorkflow('worker-heartbeat-expiry', async ({ tenantId, worker }) => {
    const blocker = await pool.connect();
    let blockerInTransaction = false;
    let heartbeatPromise = null;
    try {
      await pool.query(
        "UPDATE worker_nodes SET expires_at=clock_timestamp()+INTERVAL '500 milliseconds' WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3",
        [tenantId, worker.workerId, worker.sessionId]
      );
      await blocker.query('BEGIN');
      blockerInTransaction = true;
      await blocker.query(
        'SELECT worker_id FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2 FOR UPDATE',
        [tenantId, worker.workerId]
      );

      heartbeatPromise = persistence.workers.heartbeat(worker.workerId, {
        tenantId,
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        workerPrincipal: worker
      });

      let waiting = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const activity = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event_type='Lock'
             AND query LIKE 'SELECT 1 FROM worker_nodes%' LIMIT 1`
        );
        if (activity.rowCount === 1) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(waiting, true, 'heartbeat must wait on the held worker registry row lock');
      await blocker.query('SELECT pg_sleep(1.3)');
      await blocker.query('COMMIT');
      blockerInTransaction = false;

      await assert.rejects(
        heartbeatPromise,
        error => error.code === 'WORKER_SESSION_LOST'
      );
    } finally {
      if (blockerInTransaction) await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      if (heartbeatPromise) await heartbeatPromise.catch(() => {});
    }
  });
});


test('PostgreSQL allows a new worker session to replace an expired session after waiting for its registry row lock', async () => {
  await withRegisteredQueuedWorkflow('worker-register-takeover', async ({ tenantId, worker }) => {
    const blocker = await pool.connect();
    let blockerInTransaction = false;
    let registrationPromise = null;
    const replacement = createWorkerPersistencePrincipal({
      tenantId,
      workerId: worker.workerId,
      sessionId: 'replacement-' + randomUUID(),
      capabilities: worker.capabilities
    });
    try {
      await pool.query(
        "UPDATE worker_nodes SET expires_at=clock_timestamp()+INTERVAL '500 milliseconds' WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3",
        [tenantId, worker.workerId, worker.sessionId]
      );
      await blocker.query('BEGIN');
      blockerInTransaction = true;
      await blocker.query(
        'SELECT worker_id FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2 FOR UPDATE',
        [tenantId, worker.workerId]
      );

      registrationPromise = persistence.workers.register({
        workerId: worker.workerId,
        tenantId,
        status: 'READY',
        capabilities: worker.capabilities,
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString()
      }, tenantId, { workerPrincipal: replacement });

      let waiting = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const activity = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event_type='Lock'
             AND query LIKE 'INSERT INTO worker_nodes%' LIMIT 1`
        );
        if (activity.rowCount === 1) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(waiting, true, 'new registration must wait on the existing worker registry row');
      await blocker.query('SELECT pg_sleep(1.3)');
      await blocker.query('COMMIT');
      blockerInTransaction = false;

      const registered = await registrationPromise;
      assert.equal(registered.sessionId, replacement.sessionId);
    } finally {
      if (blockerInTransaction) await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      if (registrationPromise) await registrationPromise.catch(() => {});
      await pool.query('DELETE FROM worker_nodes WHERE tenant_id=$1 AND worker_id=$2', [tenantId, worker.workerId]);
    }
  });
});

test.after(async () => {
  await pool.end();
});
