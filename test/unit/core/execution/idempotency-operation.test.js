const test = require('node:test');
const assert = require('node:assert/strict');

const IdempotencyStore =
  require('../../../../src/core/execution/idempotency/idempotency-store');

test('operation identity separates distinct logical operations', () => {
  const store =
    new IdempotencyStore();

  const first =
    store.begin({
      executionId: 'exec-1',
      step: 1,
      tool: 'test.write',
      planRevision: 1,
      operationId: 'operation-a'
    });

  const second =
    store.begin({
      executionId: 'exec-1',
      step: 1,
      tool: 'test.write',
      planRevision: 1,
      operationId: 'operation-b'
    });

  const replay =
    store.begin({
      executionId: 'exec-1',
      step: 1,
      tool: 'test.write',
      planRevision: 1,
      operationId: 'operation-a'
    });

  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.record.operationId, 'operation-a');
});


test('in-memory idempotency is tenant-scoped and rejects terminal outcome conflicts', () => {
  const store = new IdempotencyStore();
  const common = {
    executionId: 'shared-execution',
    step: 1,
    tool: 'test.write',
    operationId: 'shared-operation'
  };

  const tenantA = store.begin({ ...common, tenantId: 'tenant-a' });
  const tenantB = store.begin({ ...common, tenantId: 'tenant-b' });
  assert.equal(tenantA.created, true);
  assert.equal(tenantB.created, true);
  assert.equal(store.begin({ ...common, tenantId: 'tenant-a' }).created, false);
  assert.equal(store.get(tenantA.key, 'tenant-a').tenantId, 'tenant-a');
  assert.equal(store.get(tenantA.key, 'tenant-b').tenantId, 'tenant-b');
  assert.equal(store.get(tenantA.key, 'tenant-c'), null);

  store.complete(tenantA.key, { owner: 'tenant-a' }, 'tenant-a');
  assert.deepEqual(store.complete(tenantA.key, { owner: 'tenant-a' }, 'tenant-a').result, { owner: 'tenant-a' });
  assert.throws(
    () => store.complete(tenantA.key, { owner: 'overwritten' }, 'tenant-a'),
    error => error.code === 'IDEMPOTENCY_TERMINAL_CONFLICT'
  );
  assert.throws(
    () => store.fail(tenantA.key, new Error('late failure'), 'tenant-a'),
    error => error.code === 'IDEMPOTENCY_TERMINAL_CONFLICT'
  );

  store.fail(tenantB.key, new Error('expected failure'), 'tenant-b');
  assert.throws(
    () => store.complete(tenantB.key, { late: true }, 'tenant-b'),
    error => error.code === 'IDEMPOTENCY_TERMINAL_CONFLICT'
  );
  assert.equal(store.delete(tenantA.key, 'tenant-c'), false);
  assert.equal(store.get(tenantA.key, 'tenant-a').status, 'completed');
  assert.equal(store.delete(tenantA.key, 'tenant-a'), true);
  assert.equal(store.get(tenantA.key, 'tenant-b').status, 'failed');
});
