const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

function plan() {
  return {
    intent: 'recovery.test',
    confidence: 1,
    steps: [
      {
        step: 1,
        tool: 'external.side.effect',
        input: { value: 'once' }
      }
    ]
  };
}

function toolRegistry(counter) {
  const tool = {
    name: 'external.side.effect',
    retryable: false
  };

  return {
    has(name) {
      return name === tool.name;
    },
    get(name) {
      assert.equal(name, tool.name);
      return tool;
    },
    async execute(name, input) {
      assert.equal(name, tool.name);
      counter.count += 1;
      return { ok: true, input };
    }
  };
}

function crashableIdempotencyRepository() {
  const records = new Map();
  let crashOnComplete = true;

  return {
    records,
    begin(args) {
      const key = args.operationId;
      const existing = records.get(key);
      if (existing) {
        return { created: false, key, record: { ...existing } };
      }

      const record = {
        key,
        executionId: args.executionId,
        step: args.step,
        tool: args.tool,
        planRevision: args.planRevision,
        operationId: args.operationId,
        status: 'running',
        result: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null
      };
      records.set(key, record);
      return { created: true, key, record: { ...record } };
    },
    findByKey(key) {
      const record = records.get(key);
      return record ? { ...record } : null;
    },
    complete(key, result) {
      const record = records.get(key);
      if (!record) return null;

      if (crashOnComplete) {
        crashOnComplete = false;
        const error = new Error('simulated process crash after external side effect');
        error.code = 'SIMULATED_CRASH';
        throw error;
      }

      record.status = 'completed';
      record.result = result;
      record.completedAt = new Date().toISOString();
      records.set(key, record);
      return { ...record };
    },
    fail() {
      // The simulated crash happens before the process can durably mark
      // the operation failed, leaving the authoritative operation as RUNNING.
      return records.values().next().value || null;
    },
    setCrashOnComplete(value) {
      crashOnComplete = value;
    }
  };
}

test('crash after external side effect never blindly replays an unknown operation', async () => {
  const repository = crashableIdempotencyRepository();
  const counter = { count: 0 };
  const loop = new AgentLoop({
    toolRegistry: toolRegistry(counter),
    idempotencyRepository: repository
  });

  const firstContext = new ExecutionContext({
    requestId: 'recovery-1',
    input: 'execute once',
    executionId: 'execution-recovery-1'
  });
  firstContext.start();
  firstContext.setPlan(plan());

  await assert.rejects(
    loop.run({
      plan: plan(),
      context: firstContext,
      runtimeContext: {
        planRevision: 1
      }
    }),
    error => error.code === 'SIMULATED_CRASH'
  );

  assert.equal(counter.count, 1);
  assert.equal(
    [...repository.records.values()][0].status,
    'running'
  );

  const restored = ExecutionContext.restore(
    firstContext.snapshot()
  );

  await assert.rejects(
    loop.run({
      plan: plan(),
      context: restored,
      runtimeContext: {
        planRevision: 1
      }
    }),
    error => error.code === 'IDEMPOTENCY_OPERATION_UNKNOWN'
  );

  assert.equal(
    counter.count,
    1,
    'recovery must not execute the external side effect again'
  );
});

test('reconciliation completes a persisted operation without replaying the external side effect', async () => {
  const repository = crashableIdempotencyRepository();
  const counter = { count: 0 };
  const authorization = {
    approvalService: {
      consumed: 0,
      consume() {
        this.consumed += 1;
        return true;
      }
    },
    assertAuthorized() {
      return {
        authorized: true,
        capability: 'external.side_effect',
        risk: 'high',
        requiresApproval: true,
        approval: { approvalId: 'approval-1' }
      };
    }
  };

  const loop = new AgentLoop({
    toolRegistry: toolRegistry(counter),
    authorizationService: authorization,
    idempotencyRepository: repository
  });

  const firstContext = new ExecutionContext({
    requestId: 'recovery-2',
    input: 'execute once',
    executionId: 'execution-recovery-2'
  });
  firstContext.start();
  firstContext.setPlan(plan());

  await assert.rejects(
    loop.run({
      plan: plan(),
      context: firstContext,
      runtimeContext: {
        planRevision: 1,
        approval: { approvalId: 'approval-1' }
      }
    }),
    error => error.code === 'SIMULATED_CRASH'
  );

  assert.equal(counter.count, 1);
  assert.equal(authorization.approvalService.consumed, 1);

  const restored = ExecutionContext.restore(
    firstContext.snapshot()
  );

  const result = await loop.run({
    plan: plan(),
    context: restored,
    runtimeContext: {
      planRevision: 1,
      approval: { approvalId: 'approval-1' },
      reconcileOperation: async ({ operationId }) => ({
        status: 'completed',
        result: {
          reconciled: true,
          operationId
        }
      })
    }
  });

  assert.equal(result.status, 'done');
  assert.equal(counter.count, 1);
  assert.equal(
    authorization.approvalService.consumed,
    1,
    'a recovered operation must not consume the approval again'
  );
  assert.equal(
    [...repository.records.values()][0].status,
    'completed'
  );
});
