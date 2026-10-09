'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AgentLoop = require('../../../../src/core/execution/agent-loop');
const ExecutionContext = require('../../../../src/core/execution/execution-context');
const IdempotencyRepository = require('../../../../src/infrastructure/persistence/json/idempotency.repository');

test('AgentLoop observes durable cancellation before entering a tool side-effect boundary', async () => {
  let executions = 0;
  const loop = new AgentLoop({
    toolRegistry: {
      has: () => true,
      get: () => ({ execute: async () => { executions += 1; return { ok: true }; } }),
      execute: async () => { executions += 1; return { ok: true }; }
    }
  });

  const context = new ExecutionContext({
    requestId: 'req-cancel',
    input: 'cancel me',
    tenantId: 'tenant-a'
  });
  context.start();

  await assert.rejects(
    loop.run({
      plan: {
        intent: 'test.cancel',
        steps: [{ step: 1, tool: 'side.effect', input: 'x', dependsOn: null }]
      },
      context,
      runtimeContext: {
        tenantId: 'tenant-a',
        isCancellationRequested: () => true
      }
    }),
    error => error.code === 'EXECUTION_CANCELLATION_REQUESTED'
  );

  assert.equal(executions, 0);
  assert.equal(context.cancellationRequested, true);
});


test('AgentLoop awaits cancellation requested at the step-start checkpoint before invoking the tool', async () => {
  let executions = 0;
  let cancellationRequested = false;
  const loop = new AgentLoop({
    toolRegistry: {
      has: () => true,
      get: () => ({ name: 'side.effect', retryable: false }),
      execute: async () => { executions += 1; return { ok: true }; }
    }
  });

  const context = new ExecutionContext({
    requestId: 'req-cancel-at-checkpoint',
    input: 'cancel before side effect',
    executionId: 'exec-cancel-at-checkpoint',
    tenantId: 'tenant-a'
  });
  context.start();

  await assert.rejects(
    loop.run({
      plan: {
        intent: 'test.cancel.checkpoint',
        steps: [{ step: 1, tool: 'side.effect', input: 'x', dependsOn: null }]
      },
      context,
      runtimeContext: {
        tenantId: 'tenant-a',
        isCancellationRequested: () => cancellationRequested,
        onCheckpoint: async ({ reason }) => {
          if (reason === 'step_started') cancellationRequested = true;
        }
      }
    }),
    error => error.code === 'EXECUTION_CANCELLATION_REQUESTED'
  );

  assert.equal(executions, 0);
  assert.equal(context.cancellationRequested, true);
  assert.equal(
    loop.idempotencyStore.records.size,
    0,
    'a cancellation before tool invocation must release its unused reservation'
  );
});


test('AgentLoop releases the idempotency reservation when the pre-effect checkpoint fails', async () => {
  const loop = new AgentLoop({
    toolRegistry: {
      has: () => true,
      get: () => ({ name: 'side.effect', retryable: false }),
      execute: async () => { throw new Error('tool must not run'); }
    }
  });
  const context = new ExecutionContext({
    requestId: 'req-checkpoint-failure',
    input: 'checkpoint failure before side effect',
    executionId: 'exec-checkpoint-failure',
    tenantId: 'tenant-a'
  });
  context.start();

  await assert.rejects(
    loop.run({
      plan: {
        intent: 'test.checkpoint.failure',
        steps: [{ step: 1, tool: 'side.effect', input: 'x', dependsOn: null }]
      },
      context,
      runtimeContext: {
        tenantId: 'tenant-a',
        onCheckpoint: async ({ reason }) => {
          if (reason === 'step_started') {
            throw new Error('durable checkpoint unavailable');
          }
        }
      }
    }),
    /durable checkpoint unavailable/
  );

  assert.equal(loop.idempotencyStore.records.size, 0);
});


test('AgentLoop releases a durable local-tenant reservation when the pre-effect checkpoint fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-idempotency-checkpoint-'));
  const repository = new IdempotencyRepository(path.join(directory, 'idempotency.json'));
  try {
    const loop = new AgentLoop({
      toolRegistry: {
        has: () => true,
        get: () => ({ name: 'side.effect', retryable: false }),
        execute: async () => { throw new Error('tool must not run'); }
      },
      idempotencyRepository: repository
    });
    const context = new ExecutionContext({
      requestId: 'req-checkpoint-failure-local',
      input: 'checkpoint failure before side effect',
      executionId: 'exec-checkpoint-failure-local'
    });
    context.start();

    await assert.rejects(
      loop.run({
        plan: {
          intent: 'test.checkpoint.failure.local',
          steps: [{ step: 1, tool: 'side.effect', input: 'x', dependsOn: null }]
        },
        context,
        runtimeContext: {
          onCheckpoint: async ({ reason }) => {
            if (reason === 'step_started') {
              throw new Error('durable checkpoint unavailable');
            }
          }
        }
      }),
      /durable checkpoint unavailable/
    );

    assert.equal(repository.count(), 0,
      'a pre-effect failure must remove the durable reservation for the canonical local tenant');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('AgentLoop completes durable local-tenant idempotency records with the canonical tenant identity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-idempotency-local-complete-'));
  const repository = new IdempotencyRepository(path.join(directory, 'idempotency.json'));
  try {
    const loop = new AgentLoop({
      toolRegistry: {
        has: () => true,
        get: () => ({ name: 'side.effect', retryable: false }),
        execute: async () => ({ ok: true })
      },
      idempotencyRepository: repository
    });
    const context = new ExecutionContext({
      requestId: 'req-local-complete',
      input: 'complete local operation',
      executionId: 'exec-local-complete'
    });
    context.start();

    const result = await loop.run({
      plan: {
        intent: 'test.local.complete',
        steps: [{ step: 1, tool: 'side.effect', input: 'x', dependsOn: null }]
      },
      context
    });

    assert.equal(result.status, 'done');
    const records = Object.values(repository.read());
    assert.equal(records.length, 1);
    assert.equal(records[0].tenantId, 'local');
    assert.equal(records[0].status, 'completed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
