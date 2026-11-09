'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OpenMausBotAgentProvider = require('../../../../src/infrastructure/agents/openmausbot-agent-provider');

test('OpenMausBot provider maps the neutral contract to fixed read-only MCP operations', async () => {
  const calls = [];
  const provider = new OpenMausBotAgentProvider({
    async callTool(name) {
      calls.push(name);
      return { provider: 'openmausbot', tool: name, untrusted: true };
    }
  });

  assert.equal(provider.id, 'openmausbot');
  await provider.health();
  await provider.listAgents();
  await provider.listChannels();
  await provider.listModels();
  assert.deepEqual(calls, [
    'get_system_health',
    'list_bots',
    'list_channels',
    'list_available_models'
  ]);
});

test('OpenMausBot provider requires a valid MCP client', () => {
  assert.throws(() => new OpenMausBotAgentProvider(null), /client is required/);
});
