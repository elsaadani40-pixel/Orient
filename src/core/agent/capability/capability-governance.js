const AppError = require('../../errors/AppError');

class CapabilityGovernance {
  constructor({
    capabilityMapper,
    capabilityRegistry,
    agentRegistry
  } = {}) {
    if (!capabilityMapper) throw new TypeError('capabilityMapper is required');
    if (!capabilityRegistry) throw new TypeError('capabilityRegistry is required');
    if (!agentRegistry) throw new TypeError('agentRegistry is required');

    this.capabilityMapper = capabilityMapper;
    this.capabilityRegistry = capabilityRegistry;
    this.agentRegistry = agentRegistry;
  }

  authorizeTool({
    agentId,
    tool
  } = {}) {
    if (!agentId || !tool) {
      throw new AppError(
        'Agent and tool are required for capability governance',
        500,
        'CAPABILITY_GOVERNANCE_INPUT_REQUIRED'
      );
    }

    const agent = this.agentRegistry.require(agentId);
    const capability = this.capabilityMapper.get(tool);

    if (!capability) {
      throw new AppError(
        `Tool "${tool}" has no registered capability mapping`,
        403,
        'TOOL_CAPABILITY_MAPPING_MISSING'
      );
    }

    if (!this.capabilityRegistry.has(capability)) {
      throw new AppError(
        `Capability "${capability}" is not registered`,
        403,
        'TOOL_CAPABILITY_NOT_REGISTERED'
      );
    }

    if (!agent.canUseCapability(capability)) {
      throw new AppError(
        `Agent "${agentId}" is not authorized for capability "${capability}"`,
        403,
        'AGENT_TOOL_CAPABILITY_FORBIDDEN'
      );
    }

    return Object.freeze({
      agentId,
      tool,
      capability,
      risk: this.capabilityRegistry.get(capability)?.risk || 'low'
    });
  }
}

module.exports = CapabilityGovernance;
