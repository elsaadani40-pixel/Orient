const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop =
  require('../../../../src/core/execution/agent-loop');
const AgentRegistry =
  require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } =
  require('../../../../src/core/agent/boundary/agent-definition');
const AgentInvocationService =
  require('../../../../src/core/agent/invocation/agent-invocation-service');

function makeRegistry() {
  const registry = new AgentRegistry();

  registry.register(new AgentDefinition({
    id: 'source',
    capabilities: ['tool:echo'],
    allowedAgentTargets: ['target']
  }));

  registry.register(new AgentDefinition({
    id: 'target',
    capabilities: ['tool:research']
  }));

  registry.register(new AgentDefinition({
    id: 'blocked',
    capabilities: ['tool:echo']
  }));

  return registry;
}

function makeContext() {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    input: 'delegate',
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

function makeLoop(execute = async () => ({ ok: true })) {
  const toolRegistry = {
    has: () => true,
    get: () => ({ name: 'echo', risk: 'low' }),
    execute
  };

  const agentRegistry = makeRegistry();

  return new AgentLoop({
    toolRegistry,
    agentRegistry,
    agentInvocationService: new AgentInvocationService({
      agentRegistry
    })
  });
}

test('AgentLoop authorizes a declared source-to-target delegation', async () => {
  const events = [];
  const loop = makeLoop();
  const context = makeContext();
  context.record = (type, data) => events.push({ type, data });

  const result = await loop.run({
    plan: {
      agentId: 'source',
      steps: [{
        tool: 'echo',
        agentId: 'source',
        capability: 'tool:echo',
        targetAgentId: 'target',
        targetCapability: 'tool:research'
      }]
    },
    context,
    runtimeContext: {
      tenantId: 'tenant-1',
      agentId: 'source'
    }
  });

  assert.equal(result.status, 'done');
  assert.ok(events.some(event =>
    event.type === 'agent.invocation.authorized' &&
    event.data.sourceAgentId === 'source' &&
    event.data.targetAgentId === 'target'
  ));
});

test('AgentLoop rejects an undeclared source-to-target delegation before tool execution', async () => {
  let executed = false;
  const loop = makeLoop(async () => {
    executed = true;
    return { ok: true };
  });

  await assert.rejects(
    () => loop.run({
      plan: {
        agentId: 'blocked',
        steps: [{
          tool: 'echo',
          agentId: 'blocked',
          capability: 'tool:echo',
          targetAgentId: 'target'
        }]
      },
      context: makeContext(),
      runtimeContext: {
        tenantId: 'tenant-1',
        agentId: 'blocked'
      }
    }),
    error => error.code === 'AGENT_TARGET_FORBIDDEN'
  );

  assert.equal(executed, false);
});
