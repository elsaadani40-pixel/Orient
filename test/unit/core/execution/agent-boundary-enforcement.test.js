const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');
const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } = require('../../../../src/core/agent/boundary/agent-definition');

function makeLoop() {
  const toolRegistry = {
    has: () => true,
    get: () => ({ name: 'echo', risk: 'low' }),
    execute: async () => ({ ok: true })
  };

  return new AgentLoop({
    toolRegistry,
    agentRegistry: makeRegistry()
  });
}

function makeRegistry() {
  const registry = new AgentRegistry();

  registry.register(new AgentDefinition({
    id: 'research',
    capabilities: ['tool:web.search']
  }));

  registry.register(new AgentDefinition({
    id: 'writer',
    capabilities: ['tool:document.write']
  }));

  return registry;
}

test('AgentLoop allows a declared capability for the selected agent', () => {
  const loop = makeLoop();
  const events = [];

  const result = loop.authorizeAgentStep({
    step: {
      tool: 'web.search',
      agentId: 'research',
      capability: 'tool:web.search'
    },
    stepNumber: 1,
    plan: {},
    runtimeContext: {},
    context: {
      record: (type, data) => events.push({ type, data })
    }
  });

  assert.deepEqual(result, {
    agentId: 'research',
    capability: 'tool:web.search'
  });
  assert.equal(events.at(-1).type, 'agent.boundary.authorized');
});

test('AgentLoop denies an undeclared capability before tool execution', () => {
  const loop = makeLoop();

  assert.throws(
    () => loop.authorizeAgentStep({
      step: {
        tool: 'web.search',
        agentId: 'writer',
        capability: 'tool:web.search'
      },
      stepNumber: 1,
      plan: {},
      runtimeContext: {},
      context: { record: () => {} }
    }),
    error => error.code === 'AGENT_CAPABILITY_FORBIDDEN'
  );
});
