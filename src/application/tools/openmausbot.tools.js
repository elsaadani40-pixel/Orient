'use strict';

const ToolInterface = require('../../core/tools/tool.interface');

function createOpenMausBotTools(provider) {
  if (!provider || typeof provider.health !== 'function' ||
      typeof provider.listAgents !== 'function' ||
      typeof provider.listChannels !== 'function' ||
      typeof provider.listModels !== 'function') {
    throw new TypeError('A registered external agent provider is required');
  }
  if (provider.id !== 'openmausbot') {
    throw new TypeError('OpenMausBot tools require the openmausbot provider');
  }

  const definitions = [
    ['openmausbot.health', provider.health, 'Check OpenMausBot service health (read-only)'],
    ['openmausbot.list_bots', provider.listAgents, 'List OpenMausBot agents and their current status (read-only)'],
    ['openmausbot.list_channels', provider.listChannels, 'List OpenMausBot channels (read-only)'],
    ['openmausbot.list_models', provider.listModels, 'List available models for OpenMausBot agents (read-only)']
  ];

  return definitions.map(([name, operation, description]) => new ToolInterface({
    name,
    description,
    capabilities: ['external.agent.read'],
    risk: 'low',
    effects: 'read_only',
    idempotency: 'idempotent',
    execute: async () => operation()
  }));
}

module.exports = createOpenMausBotTools;
