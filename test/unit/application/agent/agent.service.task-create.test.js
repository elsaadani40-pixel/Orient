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


function createAsyncRuntime() {
  const records = new Map();
  const workflows = new Map();
  let enqueueCalls = 0;
  const idempotency = {
    async begin(args) {
      const existing = records.get(args.operationId);
      if (existing) return { created: false, key: args.operationId, record: existing };
      const record = { key: args.operationId, ...args, status: 'running', result: null };
      records.set(args.operationId, record);
      return { created: true, key: args.operationId, record };
    },
    async complete(key, result) {
      const record = records.get(key);
      record.status = 'completed';
      record.result = result;
      return record;
    },
    async fail(key, error) {
      const record = records.get(key);
      record.status = 'failed';
      record.error = error;
      return record;
    }
  };
  const workflowRepository = {
    async findById(workflowId, tenantId) {
      const workflow = workflows.get(workflowId);
      return workflow && workflow.tenantId === tenantId ? { ...workflow, metadata: { ...workflow.metadata } } : null;
    },
    async findAll({ tenantId } = {}) {
      return [...workflows.values()].filter(workflow => !tenantId || workflow.tenantId === tenantId);
    }
  };
  const runtime = {
    tenantId: 'tenant-async',
    persistence: { idempotency, workflows: workflowRepository, events: { async findByExecutionId() { return []; } } },
    workflowExecutionCoordinator: {
      workflowRepository,
      async enqueue(goal, { workflowId }) {
        enqueueCalls += 1;
        const now = new Date().toISOString();
        const workflow = {
          workflowId,
          tenantId: 'tenant-async',
          state: 'QUEUED',
          createdAt: now,
          updatedAt: now,
          metadata: { taskId: workflowId }
        };
        workflows.set(workflowId, workflow);
        return { taskId: workflowId, workflowId, state: workflow.state, tenantId: workflow.tenantId, createdAt: now, updatedAt: now };
      }
    },
    async execute() { assert.fail('async task submission must not execute inline'); },
    async getExecutionStatus() { assert.fail('queued async tasks must read workflow state'); },
    async listExecutionSummaries() { return { executions: [], limit: 20, offset: 0, total: 0 }; }
  };
  return {
    service: new AgentService(runtime, { taskAcceptanceMode: 'async' }),
    runtime,
    records,
    workflows,
    get enqueueCalls() { return enqueueCalls; }
  };
}

test('opt-in async task acceptance durably enqueues once and replays the stable task identity', async () => {
  const fixture = createAsyncRuntime();
  const first = await fixture.service.createTask({
    goal: '  prepare the report  ',
    idempotencyKey: 'async-request-0001'
  });
  const replay = await fixture.service.createTask({
    goal: 'prepare the report',
    idempotencyKey: 'async-request-0001'
  });

  assert.equal(first.replayed, false);
  assert.equal(first.task.status, 'queued');
  assert.equal(first.task.id, first.task.workflowId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.task, first.task);
  assert.equal(fixture.enqueueCalls, 1);
});

test('async task status and listing resolve the workflow identity and canonical execution mapping', async () => {
  const fixture = createAsyncRuntime();
  const accepted = await fixture.service.createTask({
    goal: 'wait for approval',
    idempotencyKey: 'async-request-0002'
  });
  const workflow = fixture.workflows.get(accepted.task.workflowId);
  workflow.state = 'WAITING';
  workflow.updatedAt = new Date().toISOString();
  workflow.metadata = {
    ...workflow.metadata,
    approvalBlocked: true,
    approvalExecutionId: 'execution-async-2',
    executionId: 'execution-async-2',
    approvalId: 'approval-async-2'
  };

  const status = await fixture.service.getTaskStatus(accepted.task.id);
  assert.equal(status.id, accepted.task.id);
  assert.equal(status.status, 'waiting');
  assert.equal(status.workflowId, accepted.task.workflowId);
  assert.equal(status.executionId, 'execution-async-2');
  assert.equal(status.approvalRequired, true);

  const page = await fixture.service.listTasks({ limit: 10, offset: 0 });
  assert.equal(page.total, 1);
  assert.equal(page.executions[0].executionId, accepted.task.id);
  assert.equal(page.executions[0].canonicalExecutionId, 'execution-async-2');
  assert.equal(page.executions[0].approvalRequired, true);
});

test('async task mode fails closed when the durable workflow coordinator is unavailable', async () => {
  const service = new AgentService({
    tenantId: 'tenant-async',
    persistence: { idempotency: {
      async begin(args) { return { created: true, key: args.operationId, record: { ...args, status: 'running' } }; },
      async complete() { assert.fail('must not complete without workflow acceptance'); },
      async fail() { return true; }
    } }
  }, { taskAcceptanceMode: 'async' });

  await assert.rejects(
    service.createTask({ goal: 'queue safely', idempotencyKey: 'async-request-0003' }),
    error => error.code === 'ASYNC_TASK_COORDINATOR_REQUIRED'
  );
});


test('async task submission recovers a reserved task identity after an interrupted enqueue', async () => {
  const fixture = createAsyncRuntime();
  const enqueue = fixture.runtime.workflowExecutionCoordinator.enqueue;
  let failFirst = true;
  fixture.runtime.workflowExecutionCoordinator.enqueue = async (...args) => {
    if (failFirst) {
      failFirst = false;
      throw Object.assign(new Error('temporary scheduler transport failure'), { code: 'SCHEDULER_TEMPORARY_FAILURE' });
    }
    return enqueue(...args);
  };

  await assert.rejects(
    fixture.service.createTask({ goal: 'recover queued work', idempotencyKey: 'async-request-recovery' }),
    error => error.code === 'SCHEDULER_TEMPORARY_FAILURE'
  );
  const reservation = [...fixture.records.values()][0];
  assert.equal(reservation.status, 'running');
  assert.equal(fixture.workflows.has(reservation.executionId), false);

  const replay = await fixture.service.createTask({
    goal: 'recover queued work',
    idempotencyKey: 'async-request-recovery'
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, reservation.executionId);
  assert.equal(replay.task.status, 'queued');
  assert.equal(fixture.enqueueCalls, 1);
});
