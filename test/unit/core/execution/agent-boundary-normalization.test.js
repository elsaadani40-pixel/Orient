const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');

test('AgentLoop preserves agent boundary metadata for multi-step plans', () => {
  const loop = new AgentLoop({
    toolRegistry: {
      has: () => true,
      get: () => ({ name: 'echo', risk: 'low' }),
      execute: async () => ({ ok: true })
    }
  });

  const steps = loop.normalizeSteps({
    steps: [{
      step: 1,
      tool: 'web.search',
      input: 'x',
      agentId: 'research',
      capability: 'tool:web.search'
    }]
  });

  assert.equal(steps[0].agentId, 'research');
  assert.equal(steps[0].capability, 'tool:web.search');
});
