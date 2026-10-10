'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AgentService = require('../../../../src/application/agent/agent.service');

function createRuntime({ execute } = {}) {
  const records = new Map();
  let executions = 0;
  const idempotency = {
    async begin(args) {
      const existing = records.get(args.operationId);
      if (existing) return { created: false, key: args.operationId, record: existing };
      const record = {
        key: args.operationId,
        ...args,
        status: 'running',
        result: null
      };
      records.set(args.operationId, record);
      return { created: true, key: args.operationId, record };
    },
    async complete(key, result) {
      const record = records.get(key);
      assert.ok(record);
      record.status = 'completed';
      record.result = result;
      return record;
    },
    async fail(key, error) {
      const record = records.get(key);
      assert.ok(record);
      record.status = 'failed';
      record.error = error;
      return record;
    }
  };
  const runtime = {
    tenantId: 'tenant-test',
    persistence: { idempotency },
    async execute(goal) {
      executions += 1;
      if (execute) return execute(goal);
      return { execution: { executionId: 'execution-1' } };
    },
    async getExecutionStatus(id) {
      return {
        executionId: id,
        status: 'completed',
        currentStep: 2,
        startedAt: '2026-10-10T10:00:00.000Z',
        updatedAt: '2026-10-10T10:00:02.000Z',
        completedAt: '2026-10-10T10:00:02.000Z',
        cancellationRequested: false,
        agentLifecycle: 'completed',
        tenantId: 'must-not-leak'
      };
    }
  };
  return { service: new AgentService(runtime), records, get executions() { return executions; } };
}

test('unified task creation is durably idempotent and returns a sanitized task summary', async () => {
  const fixture = createRuntime();
  const first = await fixture.service.createTask({
    goal: '  summarize my tasks  ',
    idempotencyKey: 'request-key-0001'
  });
  const replay = await fixture.service.createTask({
    goal: 'summarize my tasks',
    idempotencyKey: 'request-key-0001'
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.task, first.task);
  assert.equal(first.task.id, 'execution-1');
  assert.equal(first.task.status, 'completed');
  assert.equal(Object.hasOwn(first.task, 'tenantId'), false);
  assert.equal(fixture.executions, 1);
});

test('unified task creation rejects reuse of one idempotency key for a different goal', async () => {
  const fixture = createRuntime();
  await fixture.service.createTask({ goal: 'first goal', idempotencyKey: 'request-key-0002' });
  await assert.rejects(
    fixture.service.createTask({ goal: 'different goal', idempotencyKey: 'request-key-0002' }),
    error => error.code === 'IDEMPOTENCY_KEY_REUSED'
  );
  assert.equal(fixture.executions, 1);
});

test('unified task creation fails closed while the same key is still running', async () => {
  const fixture = createRuntime();
  const digest = require('node:crypto').createHash('sha256').update('request-key-0003').digest('hex');
  const requestDigest = require('node:crypto').createHash('sha256').update('still running').digest('hex');
  fixture.records.set('api-v1-task-create:tenant-test:' + digest, {
    key: 'api-v1-task-create:tenant-test:' + digest,
    tool: 'api.v1.tasks.create:' + requestDigest,
    status: 'running',
    result: null
  });

  await assert.rejects(
    fixture.service.createTask({ goal: 'still running', idempotencyKey: 'request-key-0003' }),
    error => error.code === 'IDEMPOTENCY_KEY_CONFLICT'
  );
  assert.equal(fixture.executions, 0);
});

test('unified task creation requires durable idempotency storage', async () => {
  const service = new AgentService({
    tenantId: 'tenant-test',
    persistence: {},
    async execute() { assert.fail('must not execute without durable idempotency'); }
  });
  await assert.rejects(
    service.createTask({ goal: 'run safely', idempotencyKey: 'request-key-0004' }),
    error => error.code === 'TASK_IDEMPOTENCY_STORAGE_REQUIRED'
  );
});

test('runtime failures are persisted as failed idempotency records and cannot replay execution', async () => {
  const fixture = createRuntime({
    execute: async () => { throw Object.assign(new Error('runtime unavailable'), { code: 'RUNTIME_UNAVAILABLE' }); }
  });
  await assert.rejects(
    fixture.service.createTask({ goal: 'a task', idempotencyKey: 'request-key-0005' }),
    error => error.code === 'RUNTIME_UNAVAILABLE'
  );
  await assert.rejects(
    fixture.service.createTask({ goal: 'a task', idempotencyKey: 'request-key-0005' }),
    error => error.code === 'IDEMPOTENCY_KEY_CONFLICT'
  );
  assert.equal(fixture.executions, 1);
});
