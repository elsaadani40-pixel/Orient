const test = require('node:test');
const assert = require('node:assert/strict');

const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
const { registerDefaultAgents } = require('../../../../src/core/agent/catalog/default-agents');
const ModelRoutingPolicy = require('../../../../src/core/model/model-routing-policy');
const ModelRouter = require('../../../../src/core/model/model-router');

test('default agent catalog contains specialized manifests and target boundaries', () => {
  const registry = new AgentRegistry();
  registerDefaultAgents(registry);

  assert.equal(registry.require('MEMORY_AGENT').canUseCapability('tool:memory.search'), true);
  assert.equal(registry.require('MEMORY_AGENT').canUseCapability('tool:memory.delete'), true);
  assert.equal(registry.require('RESEARCH_AGENT').canUseCapability('tool:memory.delete'), false);
  assert.equal(registry.canInvoke('RESEARCH_AGENT', 'MEMORY_AGENT'), true);
  assert.equal(registry.canInvoke('MEMORY_AGENT', 'RESEARCH_AGENT'), true);
  assert.equal(registry.canInvoke('RESEARCH_AGENT', 'ORIENT_RUNTIME'), false);
});

test('model routing policy prevents an agent from using undeclared model capabilities', () => {
  const registry = new AgentRegistry();
  registerDefaultAgents(registry);

  const policy = new ModelRoutingPolicy({
    agentRegistry: registry
  });

  const localProvider = {
    id: 'local',
    locality: 'local',
    costClass: 'free',
    capabilities: ['reasoning'],
    complete: async () => ({ text: 'ok' })
  };

  assert.equal(
    policy.authorize(localProvider, {
      agentId: 'MEMORY_AGENT',
      requiredCapabilities: ['reasoning']
    }),
    false
  );

  assert.equal(
    policy.authorize(localProvider, {
      agentId: 'MEMORY_AGENT',
      requiredCapabilities: ['text-generation']
    }),
    true
  );
});

test('ModelRouter applies the agent-aware routing policy', () => {
  const registry = new AgentRegistry();
  registerDefaultAgents(registry);

  const router = new ModelRouter({
    policy: new ModelRoutingPolicy({ agentRegistry: registry }).asFunction(),
    providers: [
      {
        id: 'reasoning-only',
        locality: 'local',
        costClass: 'free',
        capabilities: ['reasoning'],
        complete: async () => ({ text: 'reasoning' })
      },
      {
        id: 'text-local',
        locality: 'local',
        costClass: 'free',
        capabilities: ['text-generation'],
        complete: async () => ({ text: 'text' })
      }
    ]
  });

  assert.equal(
    router.route({
      agentId: 'MEMORY_AGENT',
      requiredCapabilities: ['text-generation']
    }).providerId,
    'text-local'
  );

  assert.throws(
    () => router.route({
      agentId: 'MEMORY_AGENT',
      requiredCapabilities: ['reasoning']
    }),
    error => error.code === 'MODEL_ROUTE_UNAVAILABLE'
  );
});
