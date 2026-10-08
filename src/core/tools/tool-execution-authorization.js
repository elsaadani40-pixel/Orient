const EXECUTION_AUTHORIZATION = Symbol('orient.execution.authorization');

function createToolExecutionAuthorizer() {
  function authorizeContext(context, decision, binding = {}) {
    if (!context || typeof context !== 'object') {
      throw new TypeError('tool execution context is required');
    }
    if (!decision || decision.allowed !== true) {
      throw new Error('Tool execution authorization is required');
    }
    if (!binding.tool || !binding.agentId || !binding.executionId || !Number.isInteger(binding.step) || !Number.isInteger(binding.planRevision)) {
      throw new Error('Tool execution authorization binding is required');
    }

    Object.defineProperty(context, EXECUTION_AUTHORIZATION, {
      value: Object.freeze({
        tool: binding.tool,
        agentId: binding.agentId,
        executionId: binding.executionId,
        step: binding.step,
        planRevision: binding.planRevision,
        capability: decision.capability || null,
        risk: decision.risk || null,
        requiresApproval: decision.requiresApproval === true
      }),
      enumerable: false,
      configurable: false,
      writable: false
    });

    return context;
  }

  function isAuthorized(context, expected = {}) {
    const authorization = context && context[EXECUTION_AUTHORIZATION];
    if (!authorization) return false;

    return authorization.tool === expected.tool &&
      authorization.agentId === expected.agentId &&
      authorization.executionId === expected.executionId &&
      authorization.step === expected.step &&
      authorization.planRevision === expected.planRevision;
  }

  return Object.freeze({
    authorizeContext,
    isAuthorized
  });
}

module.exports = {
  createToolExecutionAuthorizer
};
