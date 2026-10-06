const test = require('node:test');
const assert = require('node:assert/strict');

const CapabilityRegistry = require('../../../../src/core/agent/capability/capability-registry');
const Capability = require('../../../../src/core/agent/capability/capability');
const CapabilityMapper = require('../../../../src/core/agent/capability/capability-mapper');
const CapabilityGovernance = require('../../../../src/core/agent/capability/capability-governance');
const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } = require('../../../../src/core/agent/boundary/agent-definition');

function makeGovernance() {
  const capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.register(new Capability({
    name: 'memory.read',
    description: 'read memory',
    risk: 'low'
  }));

  const mapper = new CapabilityMapper();
  mapper.register('memory.search', 'memory.read');

  const agents = new AgentRegistry();
  agents.register(new AgentDefinition({
    id: 'memory',
    capabilities: ['tool:memory.search', 'memory.read']
  }));
  agents.register(new AgentDefinition({
    id: 'writer',
    capabilities: ['tool:memory.search']
  }));

  return new CapabilityGovernance({
    capabilityMapper: mapper,
    capabilityRegistry,
    agentRegistry: agents
  });
}

test('governance resolves and authorizes a mapped tool capability', () => {
  const decision = makeGovernance().authorizeTool({
    agentId: 'memory',
    tool: 'memory.search'
  });

  assert.deepEqual(decision, {
    agentId: 'memory',
    tool: 'memory.search',
    capability: 'memory.read',
    risk: 'low'
  });
});

test('governance denies an agent without the mapped capability', () => {
  assert.throws(
    () => makeGovernance().authorizeTool({
      agentId: 'writer',
      tool: 'memory.search'
    }),
    error => error.code === 'AGENT_TOOL_CAPABILITY_FORBIDDEN'
  );
});

test('governance denies an unmapped tool', () => {
  assert.throws(
    () => makeGovernance().authorizeTool({
      agentId: 'memory',
      tool: 'memory.delete'
    }),
    error => error.code === 'TOOL_CAPABILITY_MAPPING_MISSING'
  );
});
