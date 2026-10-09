const test = require('node:test');
const assert = require('node:assert/strict');
const ToolRegistry = require('../../../../src/core/tools/tool.registry');

test('registered tool function checks the authorization context when authorization is required', () => {
  const registry = new ToolRegistry();
  let executions = 0;
  const registered = registry.register({
    name: 'workspace.update',
    risk: 'high',
    capabilities: ['workspace.write'],
    execute(input) {
      executions += 1;
      return { accepted: true, input };
    }
  });
  registry.requireAuthorization();

  assert.throws(
    () => registered.execute({ value: 1 }, {
      agentId: 'agent-a',
      executionId: 'exec-a',
      step: 1,
      planRevision: 1
    }),
    error => error.code === 'TOOL_EXECUTION_AUTHORIZATION_REQUIRED'
  );
  assert.equal(executions, 0);
});

test('registered tool function accepts a matching authorization context', async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  const registered = registry.register({
    name: 'workspace.update',
    risk: 'high',
    capabilities: ['workspace.write'],
    execute(input) {
      executions += 1;
      return { accepted: true, input };
    }
  });
  registry.requireAuthorization();

  const context = {
    agentId: 'agent-a',
    executionId: 'exec-a',
    step: 1,
    planRevision: 1
  };
  registry.authorizeExecutionContext(context, {
    allowed: true,
    capability: 'workspace.write',
    risk: 'high',
    requiresApproval: true
  }, {
    tool: 'workspace.update',
    agentId: 'agent-a',
    executionId: 'exec-a',
    step: 1,
    planRevision: 1
  });

  assert.deepEqual(await registered.execute({ value: 2 }, context), {
    accepted: true,
    input: { value: 2 }
  });
  assert.equal(executions, 1);
});

test('registry execute path retains authorization checks', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'workspace.update',
    risk: 'high',
    execute() {
      return 'ran';
    }
  });
  registry.requireAuthorization();

  await assert.rejects(
    () => registry.execute('workspace.update', {}),
    error => error.code === 'TOOL_EXECUTION_AUTHORIZATION_REQUIRED'
  );
});
