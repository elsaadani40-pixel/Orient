'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

test('AgentLoop persists the resolved tool input through an execution snapshot and restore', async () => {
  const received = [];
  const toolRegistry = {
    has: name => name === 'echo',
    get: name => name === 'echo' ? { name: 'echo' } : null,
    execute: async (name, input) => {
      received.push({ name, input });
      return { accepted: input };
    }
  };

  const context = new ExecutionContext({
    requestId: 'resolved-input-test',
    executionId: 'resolved-input-execution',
    tenantId: 'tenant-resolved-input',
    input: 'verify durable resolved input'
  });
  context.start();

  const resolvedInput = {
    payload: 'persist this exact input',
    metadata: { attempt: 1 }
  };
  const loop = new AgentLoop({ toolRegistry });

  const result = await loop.run({
    plan: {
      intent: 'test resolved input persistence',
      steps: [{ tool: 'echo', input: resolvedInput }]
    },
    context,
    runtimeContext: { tenantId: 'tenant-resolved-input' }
  });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].input, resolvedInput);
  assert.deepEqual(result.result, { accepted: resolvedInput });
  assert.deepEqual(context.steps[0].resolvedInput, resolvedInput);

  const restored = ExecutionContext.restore(context.snapshot());
  assert.deepEqual(restored.steps[0].resolvedInput, resolvedInput);
});
