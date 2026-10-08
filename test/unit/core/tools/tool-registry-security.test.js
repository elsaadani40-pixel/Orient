const test = require('node:test');
const assert = require('node:assert/strict');

const ToolRegistry = require('../../../../src/core/tools/tool.registry');

function tool() {
  return {
    name: 'secure.test',
    description: 'security test tool',
    async execute(input) {
      return { input, executed: true };
    }
  };
}

test('tool registry rejects direct execution when authorization is required', async () => {
  const registry = new ToolRegistry();
  registry.register(tool());
  registry.requireAuthorization();

  await assert.rejects(
    () => registry.execute('secure.test', { value: 1 }, {}),
    error => error.code === 'TOOL_EXECUTION_AUTHORIZATION_REQUIRED'
  );
});

test('tool registry accepts only an internal authorized execution context', async () => {
  const registry = new ToolRegistry();
  registry.register(tool());
  registry.requireAuthorization();

  const context = {};
  registry.authorizeExecutionContext(context, {
    allowed: true,
    capability: 'test.execute',
    risk: 'low',
    requiresApproval: false
  }, {
    tool: 'secure.test',
    agentId: 'agent.test',
    executionId: 'exec-1',
    step: 1,
    planRevision: 1
  });
  context.agentId = 'agent.test';
  context.executionId = 'exec-1';
  context.step = 1;
  context.planRevision = 1;

  const result = await registry.execute('secure.test', { value: 2 }, context);
  assert.deepEqual(result, { input: { value: 2 }, executed: true });
  assert.deepEqual(Object.keys(context), ['agentId', 'executionId', 'step', 'planRevision']);
});


test('tool registry rejects an authorized context when execution identity is tampered', async () => {
  const registry = new ToolRegistry();
  registry.register(tool());
  registry.requireAuthorization();

  const context = {
    agentId: 'agent.test',
    executionId: 'exec-1',
    step: 1,
    planRevision: 1
  };

  registry.authorizeExecutionContext(context, {
    allowed: true,
    capability: 'test.execute',
    risk: 'low',
    requiresApproval: false
  }, {
    tool: 'secure.test',
    agentId: 'agent.test',
    executionId: 'exec-1',
    step: 1,
    planRevision: 1
  });

  context.agentId = 'other.agent';

  await assert.rejects(
    () => registry.execute('secure.test', { value: 3 }, context),
    error => error.code === 'TOOL_EXECUTION_AUTHORIZATION_REQUIRED'
  );
});


test('agent loop enables the registry authorization boundary when an authorization service is configured', async () => {
  const registry = new ToolRegistry();
  registry.register(tool());

  const authorizationService = {
    async assertAuthorized() {
      return {
        allowed: true,
        capability: 'test.execute',
        risk: 'low',
        requiresApproval: false
      };
    }
  };

  const AgentLoop = require('../../../../src/core/execution/agent-loop');
  new AgentLoop({
    toolRegistry: registry,
    authorizationService
  });

  await assert.rejects(
    () => registry.execute('secure.test', { value: 4 }, {}),
    error => error.code === 'TOOL_EXECUTION_AUTHORIZATION_REQUIRED'
  );
});


test('tool registry rejects registration after sealing', () => {
  const registry = new ToolRegistry();
  registry.register(tool());
  registry.seal();

  assert.throws(
    () => registry.register({
      name: 'late.tool',
      execute: async () => ({})
    }),
    error => error.code === 'TOOL_REGISTRY_SEALED'
  );
});

test('tool registry isolates the registered execution function from source mutation', async () => {
  const registry = new ToolRegistry();
  const definition = tool();
  registry.register(definition);

  definition.execute = async () => ({ executed: false });

  const result = await registry.execute('secure.test', { value: 5 }, {});
  assert.deepEqual(result, { input: { value: 5 }, executed: true });
});


test('tool registry rejects duplicate registration without replacing the original tool', async () => {
  const registry = new ToolRegistry();
  const original = tool();
  registry.register(original);

  assert.throws(
    () => registry.register({ name: 'secure.test', execute: async () => ({ executed: false }) }),
    error => error.code === 'TOOL_ALREADY_REGISTERED' && error.statusCode === 409
  );

  const result = await registry.execute('secure.test', { value: 6 }, {});
  assert.deepEqual(result, { input: { value: 6 }, executed: true });
});
