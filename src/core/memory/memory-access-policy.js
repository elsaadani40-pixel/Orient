class MemoryAccessPolicy {
  constructor({ agentRegistry }) {
    if (!agentRegistry) {
      throw new TypeError('agentRegistry is required');
    }

    this.agentRegistry = agentRegistry;
  }

  authorize({ agentId, scope, operation = 'read' } = {}) {
    if (!agentId || !scope) {
      throw Object.assign(
        new Error('Agent and memory scope are required'),
        { code: 'MEMORY_SCOPE_REQUIRED' }
      );
    }

    if (!['read', 'write', 'delete'].includes(operation)) {
      throw Object.assign(
        new Error('Unsupported memory operation'),
        { code: 'MEMORY_OPERATION_INVALID' }
      );
    }

    const agent = this.agentRegistry.require(agentId);
    const allowed = agent.canReadMemory(scope);

    if (!allowed) {
      throw Object.assign(
        new Error('Agent is not authorized for memory scope'),
        { code: 'MEMORY_SCOPE_FORBIDDEN' }
      );
    }

    return Object.freeze({
      allowed: true,
      agentId,
      scope,
      operation
    });
  }
}

module.exports = MemoryAccessPolicy;
