const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { PostgresPersistence } = require('../../src/infrastructure/persistence/postgres/postgres-persistence');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = new PostgresPersistence({ pool });

test('PostgreSQL task idempotency is durable, tenant-scoped, and terminal-state safe', async () => {
  await persistence.initialize();

  const suffix = crypto.randomUUID();
  const tenantId = 'task-idempotency-' + suffix;
  const otherTenantId = tenantId + '-other';
  const operationId = 'api-v1-task-create:' + tenantId + ':' + suffix;
  const keyArgs = {
    executionId: 'task-create-' + suffix,
    step: 1,
    tool: 'api.v1.tasks.create:request-digest',
    planRevision: 1,
    operationId,
    tenantId
  };

  try {
    const attempts = await Promise.all([
      persistence.idempotency.begin(keyArgs),
      persistence.idempotency.begin({ ...keyArgs, executionId: keyArgs.executionId + '-racer' }),
      persistence.idempotency.begin({ ...keyArgs, executionId: keyArgs.executionId + '-retry' })
    ]);

    assert.equal(attempts.filter(item => item.created).length, 1);
    assert.equal(attempts.filter(item => !item.created).length, 2);
    const reservation = attempts.find(item => item.created);
    assert.ok(reservation?.key);
    assert.equal((await persistence.idempotency.findByKey(reservation.key, { tenantId })).status, 'running');

    // Identical operation identifiers are isolated by tenant in the database key.
    const otherTenant = await persistence.idempotency.begin({
      ...keyArgs,
      tenantId: otherTenantId,
      executionId: keyArgs.executionId + '-other'
    });
    assert.equal(otherTenant.created, true);
    assert.equal((await persistence.idempotency.findByKey(reservation.key, { tenantId: otherTenantId })).tenantId, otherTenantId);
    assert.equal(await persistence.idempotency.findByKey(reservation.key, { tenantId: tenantId + '-unauthorized' }), null);

    const taskSummary = {
      id: 'task-' + suffix,
      status: 'running',
      version: 1
    };
    const completed = await persistence.idempotency.complete(reservation.key, taskSummary, { tenantId });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(
      (await persistence.idempotency.findByKey(reservation.key, { tenantId })).result,
      taskSummary
    );

    const replay = await persistence.idempotency.begin(keyArgs);
    assert.equal(replay.created, false);
    assert.equal(replay.record.status, 'completed');
    assert.deepEqual(replay.record.result, taskSummary);

    await assert.rejects(
      () => persistence.idempotency.complete(reservation.key, { ...taskSummary, status: 'failed' }, { tenantId }),
      error => error.code === 'IDEMPOTENCY_TERMINAL_CONFLICT'
    );
    await assert.rejects(
      () => persistence.idempotency.fail(reservation.key, new Error('late failure'), { tenantId }),
      error => error.code === 'IDEMPOTENCY_TERMINAL_CONFLICT'
    );
    assert.equal(
      (await persistence.idempotency.findByKey(reservation.key, { tenantId })).status,
      'completed'
    );
  } finally {
    await persistence.idempotency.delete(operationId, { tenantId });
    await persistence.idempotency.delete(operationId, { tenantId: otherTenantId });
  }
});

test('PostgreSQL concurrent terminal writes permit only one idempotency outcome', async () => {
  await persistence.initialize();

  const suffix = crypto.randomUUID();
  const tenantId = 'task-terminal-race-' + suffix;
  const operationId = 'api-v1-task-create:' + tenantId + ':' + suffix;
  const reservation = await persistence.idempotency.begin({
    executionId: 'task-race-' + suffix,
    step: 1,
    tool: 'api.v1.tasks.create:race',
    operationId,
    tenantId
  });

  try {
    const outcomes = await Promise.allSettled([
      persistence.idempotency.complete(reservation.key, { winner: 'a' }, { tenantId }),
      persistence.idempotency.complete(reservation.key, { winner: 'b' }, { tenantId })
    ]);

    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
    const rejected = outcomes.find(item => item.status === 'rejected');
    assert.equal(rejected.reason.code, 'IDEMPOTENCY_TERMINAL_CONFLICT');
    const persisted = await persistence.idempotency.findByKey(reservation.key, { tenantId });
    assert.equal(persisted.status, 'completed');
    assert.ok(['a', 'b'].includes(persisted.result.winner));
  } finally {
    await persistence.idempotency.delete(operationId, { tenantId });
  }
});

test.after(async () => {
  await pool.end();
});
