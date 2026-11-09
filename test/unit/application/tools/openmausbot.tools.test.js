'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createOpenMausBotTools = require('../../../src/application/tools/openmausbot.tools');

test('OpenMausBot tools expose only read-only discovery operations', () => {
  const calls = [];
  const tools = createOpenMausBotTools({
    async callTool(name, input) {
      calls.push({ name, input });
      return { provider: 'openmausbot', tool: name, untrusted: true, result: { content: [] } };
    }
  });

  assert.deepEqual(tools.map(tool => tool.name), [
    'openmausbot.health',
    'openmausbot.list_bots',
    'openmausbot.list_channels',
    'openmausbot.list_models'
  ]);
  for (const tool of tools) {
    assert.equal(tool.effects, 'read_only');
    assert.equal(tool.idempotency, 'idempotent');
    assert.deepEqual(tool.capabilities, ['external.agent.read']);
  }
});

test('OpenMausBot tool maps to the fixed upstream tool name', async () => {
  const calls = [];
  const tools = createOpenMausBotTools({
    async callTool(name, input) {
      calls.push({ name, input });
      return { provider: 'openmausbot', tool: name, untrusted: true, result: { content: [] } };
    }
  });

  const result = await tools.find(tool => tool.name === 'openmausbot.list_bots').execute({});
  assert.equal(result.tool, 'list_bots');
  assert.deepEqual(calls, [{ name: 'list_bots', input: {} }]);
});

test('OpenMausBot tool factory requires a client', () => {
  assert.throws(() => createOpenMausBotTools(null), /client is required/);
});
