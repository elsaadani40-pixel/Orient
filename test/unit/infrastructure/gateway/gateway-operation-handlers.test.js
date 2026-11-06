'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GATEWAY_OPERATION_SCOPES, createGatewayOperationHandlers } = require('../../../../src/infrastructure/gateway/identity/gateway-operation-handlers');

test('only registers the explicitly scoped read-only execution lookup', () => {
  const handlers = createGatewayOperationHandlers();
  assert.deepEqual([...handlers.keys()], ['execution.get']);
  assert.equal(GATEWAY_OPERATION_SCOPES.get('execution.get'), 'execution.read');
  assert.equal(handlers.has('database.sql'), false);
});

test('execution lookup selects by verified tenant and returns only the bounded task summary', async () => {
  const calls = [];
  const handlers = createGatewayOperationHandlers();
  const result = await handlers.get('execution.get')({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ payload: { status: 'completed', currentStep: 'finalize', startedAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:01:00.000Z', completedAt: '2026-11-06T00:01:00.000Z', cancellationRequested: false, rawToolOutput: 'must-not-leak' } }] };
    }
  }, { request: { executionId: 'task-123' }, principal: { tenantId: 'tenant-from-verified-token', ownerId: '11111111-1111-4111-8111-111111111111' } });
  assert.deepEqual(calls, [{
    sql: 'SELECT payload FROM executions WHERE execution_id=$1 AND tenant_id=$2 AND owner_id=$3 LIMIT 1',
    values: ['task-123', 'tenant-from-verified-token', '11111111-1111-4111-8111-111111111111']
  }]);
  assert.deepEqual(result, { found: true, task: {
    id: 'task-123', status: 'completed', currentStep: 'finalize',
    createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:01:00.000Z',
    completedAt: '2026-11-06T00:01:00.000Z', cancellationRequested: false
  } });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('execution lookup returns a bounded not-found response', async () => {
  const handlers = createGatewayOperationHandlers();
  const result = await handlers.get('execution.get')({ async query() { return { rows: [] }; } }, {
    request: { executionId: 'task-404' }, principal: { tenantId: 'tenant-a', ownerId: '11111111-1111-4111-8111-111111111111' }
  });
  assert.deepEqual(result, { found: false, task: null });
});

test('execution lookup rejects extra request fields and invalid identifiers before SQL', async () => {
  const handlers = createGatewayOperationHandlers();
  let calls = 0;
  const client = { async query() { calls += 1; return { rows: [] }; } };
  await assert.rejects(handlers.get('execution.get')(client, {
    request: { executionId: 'task-1', tenantId: 'attacker' }, principal: { tenantId: 'tenant-a' }
  }), error => error.code === 'GATEWAY_OPERATION_REQUEST_INVALID');
  await assert.rejects(handlers.get('execution.get')(client, {
    request: { executionId: 'bad/id' }, principal: { tenantId: 'tenant-a' }
  }), error => error.code === 'GATEWAY_OPERATION_REQUEST_INVALID');
  assert.equal(calls, 0);
});


test('execution lookup rejects a missing verified owner before SQL', async () => {
  const handlers = createGatewayOperationHandlers();
  let calls = 0;
  const client = { async query() { calls += 1; return { rows: [] }; } };
  await assert.rejects(handlers.get('execution.get')(client, {
    request: { executionId: 'task-1' },
    principal: { tenantId: 'tenant-a' }
  }), error => error.code === 'GATEWAY_OPERATION_REQUEST_INVALID');
  assert.equal(calls, 0);
});
