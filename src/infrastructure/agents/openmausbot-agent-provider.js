'use strict';

class OpenMausBotAgentProvider {
  constructor(client) {
    if (!client || typeof client.callTool !== 'function') {
      throw new TypeError('OpenMausBot MCP client is required');
    }
    this.id = 'openmausbot';
    this.client = client;
  }

  health() {
    return this.client.callTool('get_system_health');
  }

  listAgents() {
    return this.client.callTool('list_bots');
  }

  listChannels() {
    return this.client.callTool('list_channels');
  }

  listModels() {
    return this.client.callTool('list_available_models');
  }
}

module.exports = OpenMausBotAgentProvider;
