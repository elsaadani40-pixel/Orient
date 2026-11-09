'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AgentService = require('../../../../src/application/agent/agent.service');

function storePersistedExecution(persistedExecutions, executionId, tenantId = 'tenant-test') {
  persistedExecutions.set(executionId, {
    executionId,
    tenantId,
    metadata: { tenantId }
  });
}

function createRuntime({
  execute, status = 'completed', statusExecutionId,
  failFirstComplete = false, failFirstStatusLookup = false,
  persistedTenantId = 'tenant-test', persistExecution = true
} = {}) {
  const records = new Map();
  const persistedExecutions = new Map();
  let executions = 0;
  let completeCalls = 0;
  let statusLookups = 0;
  const idempotency = {
    async begin(args) {
      const existing = records.get(args.operationId);
      if (existing) return { created: false, key: args.operationId, record: existing };
      const record = { key: args.operationId, ...args, status: 'running', result: null };
      records.set(args.operationId, record);
      return { created: true, key: args.operationId, record };
    },
    async complete(key, result) {
      completeCalls += 1;
      if (failFirstComplete && completeCalls === 1) throw new Error('simulated persistence interruption');
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
    persistence: {
      idempotency,
      executions: {
        async findById(id, options = {}) {
          if (options.tenantId !== 'tenant-test') return null;
          return persistedExecutions.get(id) || null;
        }
      }
    },
    async execute(goal, options = {}) {
      executions += 1;
      if (execute) return execute(goal, options, persistedExecutions);
      if (persistExecution) {
        storePersistedExecution(persistedExecutions, options.executionId, persistedTenantId);
      }
      return { execution: { executionId: options.executionId } };
    },
    async getExecutionStatus(id) {
      statusLookups += 1;
      if (failFirstStatusLookup && statusLookups === 1) throw new Error('simulated transient status read failure');
      return {
        executionId: statusExecutionId || id,
        status,
        currentStep: 2,
        startedAt: '2026-10-10T10:00:00.000Z',
        updatedAt: '2026-10-10T10:00:02.000Z',
        completedAt: status === 'completed' ? '2026-10-10T10:00:02.000Z' : null,
        cancellationRequested: false,
        agentLifecycle: status === 'awaiting_approval' ? 'paused' : 'completed',
        tenantId: 'must-not-leak'
      };
    }
  };
  return {
    service: new AgentService(runtime),
    records,
    persistedExecutions,
    get executions() { return executions; },
    get statusLookups() { return statusLookups; }
  };
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
  assert.match(first.task.id, /^[0-9a-f-]{36}$/i);
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
    execute: async () => { throw Object.assign(new Error('runtime unavailable'), { code: 'RUNTIME_UNAVAILABLE', executionAdmission: 'rejected' }); }
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


test('approval-required execution is accepted as a durable task and does not retry the high-risk action', async () => {
  const fixture = createRuntime({
    status: 'awaiting_approval',
    execute: async (_goal, options, persistedExecutions) => {
      storePersistedExecution(persistedExecutions, options.executionId);
      throw Object.assign(new Error('Owner approval is required'), {
        code: 'APPROVAL_REQUIRED',
        executionContext: { executionId: options.executionId }
      });
    }
  });

  const first = await fixture.service.createTask({
    goal: 'inspect and propose a project change, then execute it with owner approval',
    idempotencyKey: 'request-key-approval-0001'
  });
  const replay = await fixture.service.createTask({
    goal: 'inspect and propose a project change, then execute it with owner approval',
    idempotencyKey: 'request-key-approval-0001'
  });

  assert.match(first.task.id, /^[0-9a-f-]{36}$/i);
  assert.equal(first.task.status, 'awaiting_approval');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.task, first.task);
  assert.equal(fixture.executions, 1);
});


test('task creation fails closed when Runtime returns a different execution ID', async () => {
  const fixture = createRuntime({
    execute: async (_goal, options, persistedExecutions) => {
      persistedExecutions.set(options.executionId, {
        executionId: options.executionId, tenantId: 'tenant-test', metadata: { tenantId: 'tenant-test' }
      });
      return { execution: { executionId: 'different-execution-id' } };
    }
  });
  await assert.rejects(
    fixture.service.createTask({ goal: 'verify canonical identity', idempotencyKey: 'request-key-mismatch-01' }),
    error => error.code === 'TASK_EXECUTION_ID_MISMATCH'
  );
  assert.equal(fixture.executions, 1);
});

test('task creation fails closed when persisted status has a different execution ID', async () => {
  const fixture = createRuntime({ statusExecutionId: 'different-persisted-execution-id' });
  await assert.rejects(
    fixture.service.createTask({ goal: 'verify persisted identity', idempotencyKey: 'request-key-mismatch-02' }),
    error => error.code === 'TASK_EXECUTION_ID_MISMATCH'
  );
  assert.equal(fixture.executions, 1);
});

test('task retry reconciles an execution persisted before idempotency completion', async () => {
  const fixture = createRuntime({ failFirstComplete: true });
  await assert.rejects(
    fixture.service.createTask({ goal: 'recover durable task', idempotencyKey: 'request-key-recovery-01' }),
    /simulated persistence interruption/
  );
  const retry = await fixture.service.createTask({ goal: 'recover durable task', idempotencyKey: 'request-key-recovery-01' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.task.status, 'completed');
  assert.match(retry.task.id, /^[0-9a-f-]{36}$/i);
  assert.equal(fixture.executions, 1);
});

test('transient status lookup failure remains recoverable without a second Runtime execution', async () => {
  const fixture = createRuntime({ failFirstStatusLookup: true });
  await assert.rejects(
    fixture.service.createTask({ goal: 'recover after status read failure', idempotencyKey: 'request-key-status-recovery-01' }),
    /simulated transient status read failure/
  );
  assert.equal([...fixture.records.values()][0].status, 'running');
  const retry = await fixture.service.createTask({ goal: 'recover after status read failure', idempotencyKey: 'request-key-status-recovery-01' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.task.status, 'completed');
  assert.equal(fixture.executions, 1);
});

test('approval pause survives transient status lookup failure without repeating the high-risk action', async () => {
  const fixture = createRuntime({
    status: 'awaiting_approval',
    failFirstStatusLookup: true,
    execute: async (_goal, options, persistedExecutions) => {
      persistedExecutions.set(options.executionId, {
        executionId: options.executionId, tenantId: 'tenant-test', metadata: { tenantId: 'tenant-test' }
      });
      throw Object.assign(new Error('Owner approval is required'), {
        code: 'APPROVAL_REQUIRED', executionContext: { executionId: options.executionId }
      });
    }
  });
  await assert.rejects(
    fixture.service.createTask({ goal: 'pause for owner approval', idempotencyKey: 'request-key-approval-recovery-02' }),
    /simulated transient status read failure/
  );
  assert.equal([...fixture.records.values()][0].status, 'running');
  const retry = await fixture.service.createTask({ goal: 'pause for owner approval', idempotencyKey: 'request-key-approval-recovery-02' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.task.status, 'awaiting_approval');
  assert.equal(fixture.executions, 1);
});

test('unclassified Runtime error after durable admission is reconciled instead of terminalized', async () => {
  const fixture = createRuntime({
    execute: async (_goal, options, persistedExecutions) => {
      persistedExecutions.set(options.executionId, {
        executionId: options.executionId, tenantId: 'tenant-test', metadata: { tenantId: 'tenant-test' }
      });
      throw Object.assign(new Error('response lost after durable admission'), { code: 'RUNTIME_RESPONSE_LOST' });
    }
  });
  await assert.rejects(
    fixture.service.createTask({ goal: 'recover uncertain Runtime admission', idempotencyKey: 'request-key-unknown-admission-01' }),
    error => error.code === 'RUNTIME_RESPONSE_LOST'
  );
  assert.equal([...fixture.records.values()][0].status, 'running');
  const retry = await fixture.service.createTask({ goal: 'recover uncertain Runtime admission', idempotencyKey: 'request-key-unknown-admission-01' });
  assert.equal(retry.replayed, true);
  assert.equal(fixture.executions, 1);
});

test('tenant-mismatched durable execution is rejected and remains non-replayable', async () => {
  const fixture = createRuntime({ persistedTenantId: 'tenant-other' });
  await assert.rejects(
    fixture.service.createTask({ goal: 'reject cross-tenant execution', idempotencyKey: 'request-key-tenant-mismatch-01' }),
    error => error.code === 'TASK_EXECUTION_ID_MISMATCH'
  );
  await assert.rejects(
    fixture.service.createTask({ goal: 'reject cross-tenant execution', idempotencyKey: 'request-key-tenant-mismatch-01' }),
    error => error.code === 'TASK_EXECUTION_ID_MISMATCH'
  );
  assert.equal(fixture.executions, 1);
});

test('task creation stays recoverable until the durable execution record is observable', async () => {
  const fixture = createRuntime({ persistExecution: false });
  await assert.rejects(
    fixture.service.createTask({ goal: 'wait for durable execution visibility', idempotencyKey: 'request-key-durable-visibility-01' }),
    error => error.code === 'TASK_EXECUTION_NOT_DURABLE' && error.statusCode === 503
  );
  const [record] = [...fixture.records.values()];
  assert.equal(record.status, 'running');
  assert.equal(fixture.executions, 1);
  storePersistedExecution(fixture.persistedExecutions, record.executionId);
  const retry = await fixture.service.createTask({ goal: 'wait for durable execution visibility', idempotencyKey: 'request-key-durable-visibility-01' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.task.id, record.executionId);
  assert.equal(retry.task.status, 'completed');
  assert.equal(fixture.executions, 1);
});

test('approval-required task stays recoverable until its durable execution row is visible', async () => {
  const fixture = createRuntime({
    status: 'awaiting_approval',
    persistExecution: false,
    execute: async (_goal, options) => {
      throw Object.assign(new Error('Owner approval is required'), {
        code: 'APPROVAL_REQUIRED', executionContext: { executionId: options.executionId }
      });
    }
  });
  await assert.rejects(
    fixture.service.createTask({ goal: 'wait for approval execution durability', idempotencyKey: 'request-key-approval-durable-visibility-01' }),
    error => error.code === 'TASK_EXECUTION_NOT_DURABLE' && error.statusCode === 503
  );
  const [record] = [...fixture.records.values()];
  assert.equal(record.status, 'running');
  assert.equal(fixture.executions, 1);
  storePersistedExecution(fixture.persistedExecutions, record.executionId);
  const retry = await fixture.service.createTask({ goal: 'wait for approval execution durability', idempotencyKey: 'request-key-approval-durable-visibility-01' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.task.id, record.executionId);
  assert.equal(retry.task.status, 'awaiting_approval');
  assert.equal(fixture.executions, 1);
});
