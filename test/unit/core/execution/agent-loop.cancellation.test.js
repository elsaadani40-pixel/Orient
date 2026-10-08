'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

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
