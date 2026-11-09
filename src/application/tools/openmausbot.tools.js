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
    ['openmausbot.health', provider.health, 'التحقق من اتصال OpenMausBot وحالة خدمته (قراءة فقط)'],
    ['openmausbot.list_bots', provider.listAgents, 'عرض قائمة وكلاء OpenMausBot وحالتهم الحالية (قراءة فقط)'],
    ['openmausbot.list_channels', provider.listChannels, 'عرض قنوات فريق OpenMausBot (قراءة فقط)'],
    ['openmausbot.list_models', provider.listModels, 'عرض النماذج المتاحة لوكلاء OpenMausBot (قراءة فقط)']
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
