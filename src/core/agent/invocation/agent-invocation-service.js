const crypto = require('crypto');

class AgentInvocationService {
  constructor({ agentRegistry }) {
    if (!agentRegistry) {
      throw new TypeError('agentRegistry is required');
    }

    this.agentRegistry = agentRegistry;
  }

  authorize({
    sourceAgentId,
    targetAgentId,
    capability = null,
    reason = null
  } = {}) {
    if (!sourceAgentId || !targetAgentId) {
      throw Object.assign(
        new Error('Source and target agents are required'),
        { code: 'AGENT_INVOCATION_AGENTS_REQUIRED' }
      );
    }

    const source = this.agentRegistry.require(sourceAgentId);
    const target = this.agentRegistry.require(targetAgentId);

    if (!source.canCallAgent(target.id)) {
      throw Object.assign(
        new Error('Source agent is not authorized to invoke target agent'),
        { code: 'AGENT_TARGET_FORBIDDEN' }
      );
    }

    if (capability && !target.canUseCapability(capability)) {
      throw Object.assign(
        new Error('Target agent does not declare the requested capability'),
        { code: 'AGENT_TARGET_CAPABILITY_FORBIDDEN' }
      );
    }

    return Object.freeze({
      invocationId: crypto.randomUUID(),
      sourceAgentId: source.id,
      targetAgentId: target.id,
      capability,
      reason
    });
  }
}

module.exports = AgentInvocationService;
