'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createOpenMausBotTools = require('../../../../src/application/tools/openmausbot.tools');

function provider(calls = []) {
  return {
    id: 'openmausbot',
    async health() { calls.push('health'); return { tool: 'get_system_health' }; },
    async listAgents() { calls.push('agents'); return { tool: 'list_bots' }; },
    async listChannels() { calls.push('channels'); return { tool: 'list_channels' }; },
    async listModels() { calls.push('models'); return { tool: 'list_available_models' }; }
  };
}

test('OpenMausBot tools expose only read-only discovery operations', () => {
  const tools = createOpenMausBotTools(provider());

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

test('OpenMausBot tool maps to the normalized provider operation', async () => {
  const calls = [];
  const tools = createOpenMausBotTools(provider(calls));

  const result = await tools.find(tool => tool.name === 'openmausbot.list_bots').execute({});
  assert.equal(result.tool, 'list_bots');
  assert.deepEqual(calls, ['agents']);
});

test('OpenMausBot tool factory rejects missing or mismatched providers', () => {
  assert.throws(() => createOpenMausBotTools(null), /provider is required/);
  assert.throws(() => createOpenMausBotTools({ ...provider(), id: 'another-provider' }), /require the openmausbot provider/);
});
