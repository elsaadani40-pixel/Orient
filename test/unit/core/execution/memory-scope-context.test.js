const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');
const ToolRegistry = require('../../../../src/core/tools/tool.registry');
const ToolInterface = require('../../../../src/core/tools/tool.interface');
const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } = require('../../../../src/core/agent/boundary/agent-definition');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

test('runtime injects the authorized step memory scope, not an arbitrary runtime override', async () => {
  const tools = new ToolRegistry();
  let observedContext = null;

  tools.register(new ToolInterface({
    name: 'memory.test',
    description: 'test',
    execute: async (_input, context) => {
      observedContext = context;
      return { ok: true };
    }
  }));

  const agents = new AgentRegistry();
  agents.register(new AgentDefinition({
    id: 'MEMORY_AGENT',
    capabilities: ['tool:memory.test'],
    allowedMemoryScopes: ['shared.memory']
  }));

  const loop = new AgentLoop({
    toolRegistry: tools,
    agentRegistry: agents
  });

  const context = new ExecutionContext({
    requestId: 'req-memory-scope',
    input: 'test',
    tenantId: 'tenant-a'
  });

  context.start();

  await loop.run({
    plan: {
      intent: 'memory.test',
      agentId: 'MEMORY_AGENT',
      steps: [{
        tool: 'memory.test',
        agentId: 'MEMORY_AGENT',
        capability: 'tool:memory.test',
        memoryScope: 'shared.memory',
        input: null,
        dependsOn: null
      }]
    },
    context,
    runtimeContext: {
      tenantId: 'tenant-a',
      memoryScope: 'personal'
    }
  });

  assert.equal(observedContext.agentId, 'MEMORY_AGENT');
  assert.equal(observedContext.memoryScope, 'shared.memory');
  assert.equal(observedContext.tenantId, 'tenant-a');
});
