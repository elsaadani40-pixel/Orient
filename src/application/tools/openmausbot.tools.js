const ToolInterface = require('../../core/tools/tool.interface');

function createOpenMausBotTools(client) {
  if (!client || typeof client.callTool !== 'function') {
    throw new TypeError('OpenMausBot MCP client is required');
  }

  const definitions = [
    ['openmausbot.health', 'get_system_health', 'التحقق من اتصال OpenMausBot وحالة خدمته (قراءة فقط)'],
    ['openmausbot.list_bots', 'list_bots', 'عرض قائمة وكلاء OpenMausBot وحالتهم الحالية (قراءة فقط)'],
    ['openmausbot.list_channels', 'list_channels', 'عرض قنوات فريق OpenMausBot (قراءة فقط)'],
    ['openmausbot.list_models', 'list_available_models', 'عرض النماذج المتاحة لوكلاء OpenMausBot (قراءة فقط)']
  ];

  return definitions.map(([name, upstreamName, description]) => new ToolInterface({
    name,
    description,
    capabilities: ['external.agent.read'],
    risk: 'low',
    effects: 'read_only',
    idempotency: 'idempotent',
    execute: async input => client.callTool(upstreamName, input || {})
  }));
}

module.exports = createOpenMausBotTools;
