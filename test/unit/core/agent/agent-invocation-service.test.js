const test = require('node:test');
const assert = require('node:assert/strict');

const AgentRegistry =
  require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } =
  require('../../../../src/core/agent/boundary/agent-definition');
const AgentInvocationService =
  require('../../../../src/core/agent/invocation/agent-invocation-service');

function service() {
  const registry = new AgentRegistry();

  registry.register(new AgentDefinition({
    id: 'source',
    capabilities: ['tool:invoke'],
    allowedAgentTargets: ['target']
  }));

  registry.register(new AgentDefinition({
    id: 'target',
    capabilities: ['tool:research']
  }));

  registry.register(new AgentDefinition({
    id: 'blocked',
    capabilities: ['tool:research']
  }));

  return new AgentInvocationService({
    agentRegistry: registry
  });
}

test('AgentInvocationService authorizes a declared target and capability', () => {
  const invocation = service().authorize({
    sourceAgentId: 'source',
    targetAgentId: 'target',
    capability: 'tool:research',
    reason: 'delegation'
  });

  assert.equal(invocation.sourceAgentId, 'source');
  assert.equal(invocation.targetAgentId, 'target');
  assert.equal(invocation.capability, 'tool:research');
  assert.equal(invocation.reason, 'delegation');
  assert.match(invocation.invocationId, /^[0-9a-f-]{36}$/);
});

test('AgentInvocationService rejects undeclared target', () => {
  assert.throws(
    () => service().authorize({
      sourceAgentId: 'blocked',
      targetAgentId: 'target'
    }),
    error => error.code === 'AGENT_TARGET_FORBIDDEN'
  );
});

test('AgentInvocationService rejects undeclared target capability', () => {
  assert.throws(
    () => service().authorize({
      sourceAgentId: 'source',
      targetAgentId: 'target',
      capability: 'tool:delete'
    }),
    error => error.code === 'AGENT_TARGET_CAPABILITY_FORBIDDEN'
  );
});
