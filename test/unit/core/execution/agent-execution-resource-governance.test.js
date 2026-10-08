const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

test('agent loop rejects execution after its wall-clock budget before external execution', async () => {
  let executed = false;
  const clockValues = [0, 100];
  let clockIndex = 0;

  const loop = new AgentLoop({
    toolRegistry: {
      has() { return true; },
      get() { return { name: 'test.tool', execute: async () => { executed = true; return { ok: true }; } }; },
      async execute() { executed = true; return { ok: true }; }
    },
    maxExecutionMs: 100,
    clock: () => clockValues[Math.min(clockIndex++, clockValues.length - 1)]
  });

  const context = new ExecutionContext({ requestId: 'resource-budget', input: 'test' });
  context.start();
  context.setPlan({ intent: 'test', steps: [{ step: 1, tool: 'test.tool', input: 'ok' }] });


  await assert.rejects(
    () => loop.run({ plan: { intent: 'test', steps: [{ step: 1, tool: 'test.tool', input: 'ok' }] }, context }),
    error => error.code === 'MAX_EXECUTION_TIME_EXCEEDED'
  );
  assert.equal(executed, false);
});

test('agent loop enforces a configurable step budget', async () => {
  let executed = 0;

  const loop = new AgentLoop({
    toolRegistry: {
      has() { return true; },
      get() { return { name: 'test.tool', execute: async () => { executed += 1; return { ok: true }; } }; },
      async execute() { executed += 1; return { ok: true }; }
    },
    maxSteps: 1
  });

  const context = new ExecutionContext({ requestId: 'step-budget', input: 'test' });
  context.start();
  const plan = {
    intent: 'test',
    steps: [
      { step: 1, tool: 'test.tool', input: 'one' },
      { step: 2, tool: 'test.tool', input: 'two' }
    ]
  };
  context.setPlan(plan);

  await assert.rejects(
    () => loop.run({ plan, context }),
    error => error.code === 'MAX_EXECUTION_STEPS_EXCEEDED'
  );
  assert.equal(executed, 1);
});
