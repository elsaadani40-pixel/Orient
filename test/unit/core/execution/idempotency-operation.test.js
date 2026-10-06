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
