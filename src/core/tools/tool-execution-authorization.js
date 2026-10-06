const EXECUTION_AUTHORIZATION = Symbol('orient.execution.authorization');

function authorizeContext(context, decision) {
  if (!context || typeof context !== 'object') {
    throw new TypeError('tool execution context is required');
  }
  if (!decision || decision.allowed !== true) {
    throw new Error('Tool execution authorization is required');
  }
  Object.defineProperty(context, EXECUTION_AUTHORIZATION, {
    value: Object.freeze({
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

function isAuthorized(context) {
  return Boolean(context && context[EXECUTION_AUTHORIZATION]);
}

module.exports = {
  authorizeContext,
  isAuthorized
};
