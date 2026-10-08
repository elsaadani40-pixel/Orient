const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentDefinition } =
  require('../../../../src/core/agent/boundary/agent-definition');
const AgentRegistry =
  require('../../../../src/core/agent/boundary/agent-registry');
const MemoryAccessPolicy =
  require('../../../../src/core/memory/memory-access-policy');

test('agent boundaries deny undeclared capability, memory scope, and agent target', () => {
  const registry = new AgentRegistry();

  registry.register(new AgentDefinition({
    id: 'research',
    capabilities: ['web.read', 'memory.read'],
    allowedMemoryScopes: ['shared.research'],
    allowedAgentTargets: ['writer']
  }));

  registry.register(new AgentDefinition({
    id: 'writer',
    capabilities: ['document.write'],
    allowedMemoryScopes: ['shared.writing'],
    allowedAgentTargets: []
  }));

  const research = registry.require('research');

  assert.equal(research.canUseCapability('web.read'), true);
  assert.equal(research.canUseCapability('document.write'), false);
  assert.equal(registry.canInvoke('research', 'writer'), true);
  assert.equal(registry.canInvoke('writer', 'research'), false);

  const policy = new MemoryAccessPolicy({ agentRegistry: registry });
  assert.equal(policy.authorize({
    agentId: 'research',
    scope: 'shared.research'
  }).allowed, true);

  assert.throws(
    () => policy.authorize({
      agentId: 'research',
      scope: 'shared.research',
      operation: 'write'
    }),
    error => error.code === 'MEMORY_OPERATION_FORBIDDEN'
  );

  assert.throws(
    () => policy.authorize({
      agentId: 'research',
      scope: 'shared.writing'
    }),
    error => error.code === 'MEMORY_SCOPE_FORBIDDEN'
  );
});


test('agent definitions cannot be mutated to escalate capabilities or risk', () => {
  const agent = new AgentDefinition({
    id: 'immutable-agent',
    capabilities: ['safe.read'],
    allowedMemoryScopes: ['profile'],
    allowedAgentTargets: ['worker'],
    risk: 'low'
  });

  assert.throws(() => {
    agent.capabilities = ['*'];
  }, TypeError);
  assert.throws(() => {
    agent.risk = 'critical';
  }, TypeError);

  assert.equal(agent.canUseCapability('*'), false);
  assert.equal(agent.canUseCapability('safe.read'), true);
  assert.equal(agent.risk, 'low');
});
