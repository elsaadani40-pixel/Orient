const test = require('node:test');
const assert = require('node:assert/strict');

const ToolRegistry = require('../../../../src/core/tools/tool.registry');
const { authorizeContext } = require('../../../../src/core/tools/tool-execution-authorization');

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
  authorizeContext(context, {
    allowed: true,
    capability: 'test.execute',
    risk: 'low',
    requiresApproval: false
  });

  const result = await registry.execute('secure.test', { value: 2 }, context);
  assert.deepEqual(result, { input: { value: 2 }, executed: true });
  assert.equal(Object.keys(context).length, 0);
});
