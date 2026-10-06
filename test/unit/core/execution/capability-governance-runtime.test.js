const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');
const CapabilityRegistry = require('../../../../src/core/agent/capability/capability-registry');
const Capability = require('../../../../src/core/agent/capability/capability');
const CapabilityMapper = require('../../../../src/core/agent/capability/capability-mapper');
const CapabilityGovernance = require('../../../../src/core/agent/capability/capability-governance');
const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } = require('../../../../src/core/agent/boundary/agent-definition');

function makeLoop(agentCapabilities, execute) {
  const agents = new AgentRegistry();
  agents.register(new AgentDefinition({
    id: 'memory',
    capabilities: ['tool:memory.search', ...agentCapabilities]
  }));

  const capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.register(new Capability({
    name: 'memory.read',
    description: 'read memory',
    risk: 'low'
  }));

  const mapper = new CapabilityMapper();
  mapper.register('memory.search', 'memory.read');

  const governance = new CapabilityGovernance({
    capabilityMapper: mapper,
    capabilityRegistry,
    agentRegistry: agents
  });

  return new AgentLoop({
    toolRegistry: {
      has: name => name === 'memory.search',
      get: name => ({ name, risk: 'low' }),
      execute
    },
    agentRegistry: agents,
    capabilityGovernance: governance
  });
}

function context() {
  return {
    executionId: 'e1',
    requestId: 'r1',
    input: 'search',
    tenantId: 'tenant-1',
    steps: [],
    observations: [],
    status: 'executing',
    currentStep: 0,
    record: () => {},
    setTool: () => {},
    startStep: () => {},
    completeStep: () => {},
    failStep: () => {},
    addObservation: () => {}
  };
}

test('runtime enforces mapped capability before tool execution', async () => {
  let executed = false;
  const loop = makeLoop(['memory.read'], async () => {
    executed = true;
    return { ok: true };
  });

  const result = await loop.run({
    plan: {
      agentId: 'memory',
      steps: [{
        tool: 'memory.search',
        agentId: 'memory',
        capability: 'tool:memory.search'
      }]
    },
    context: context(),
    runtimeContext: { tenantId: 'tenant-1', agentId: 'memory' }
  });

  assert.equal(result.status, 'done');
  assert.equal(executed, true);
});

test('runtime denies mapped capability missing from agent before tool execution', async () => {
  let executed = false;
  const loop = makeLoop([], async () => {
    executed = true;
    return { ok: true };
  });

  await assert.rejects(
    () => loop.run({
      plan: {
        agentId: 'memory',
        steps: [{
          tool: 'memory.search',
          agentId: 'memory',
          capability: 'tool:memory.search'
        }]
      },
      context: context(),
      runtimeContext: { tenantId: 'tenant-1', agentId: 'memory' }
    }),
    error => error.code === 'AGENT_TOOL_CAPABILITY_FORBIDDEN'
  );

  assert.equal(executed, false);
});
