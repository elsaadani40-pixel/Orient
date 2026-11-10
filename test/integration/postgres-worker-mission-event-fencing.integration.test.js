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

test.after(async () => {
  await pool.end();
});
