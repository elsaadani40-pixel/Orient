const test = require('node:test');
const assert = require('node:assert/strict');

const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');

test('runtime rejects oversized input before orchestration', async () => {
  const runtime = new OrientRuntime({
    toolRegistry: { get() { return null; } },
    agentOrchestrator: {},
    maxInputChars: 4
  });

  const result = await runtime.execute('12345');

  assert.equal(result.code, 'INPUT_TOO_LARGE');
  assert.equal(result.type, 'error');
});


test('agent loop rejects oversized tool input before external execution', async () => {
  const AgentLoop = require('../../../../src/core/execution/agent-loop');
  const ExecutionContext = require('../../../../src/core/execution/execution-context');

  let executed = false;
  const loop = new AgentLoop({
    toolRegistry: {
      has() { return true; },
      get() { return { name: 'test.tool', execute: async () => { executed = true; return { ok: true }; } }; },
      async execute() { executed = true; return { ok: true }; }
    },
    maxToolInputChars: 4
  });

  const context = new ExecutionContext({ requestId: 'resource-limit', input: 'test' });
  context.start();
  context.setPlan({ intent: 'test', steps: [{ step: 1, tool: 'test.tool', input: '12345' }] });

  await assert.rejects(
    () => loop.run({ plan: { intent: 'test', steps: [{ step: 1, tool: 'test.tool', input: '12345' }] }, context }),
    error => error.code === 'TOOL_INPUT_TOO_LARGE'
  );
  assert.equal(executed, false);
});
