'use strict';

const GATEWAY_OPERATION_SCOPES = new Map([
  ['execution.get', 'execution.read']
]);

function invalidRequest() {
  throw Object.assign(new Error('Gateway operation request is invalid'), { code: 'GATEWAY_OPERATION_REQUEST_INVALID' });
}

function safeText(value, max = 120) {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, '').slice(0, max) : null;
}

function createGatewayOperationHandlers() {
  const handlers = new Map();
  handlers.set('execution.get', async (client, { request, principal }) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.getPrototypeOf(request) !== Object.prototype ||
        Object.keys(request).length !== 1 ||
        typeof request.executionId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(request.executionId)) {
      invalidRequest();
    }
    const result = await client.query(
      'SELECT payload FROM executions WHERE execution_id=$1 AND tenant_id=$2 LIMIT 1',
      [request.executionId, principal.tenantId]
    );
    if (!result.rows.length) return { found: false, task: null };
    const payload = result.rows[0].payload && typeof result.rows[0].payload === 'object'
      ? result.rows[0].payload
      : {};
    return {
      found: true,
      task: {
        id: request.executionId,
        status: safeText(payload.status, 40),
        currentStep: safeText(payload.currentStep, 120),
        createdAt: safeText(payload.startedAt || payload.createdAt, 40),
        updatedAt: safeText(payload.updatedAt, 40),
        completedAt: safeText(payload.completedAt, 40),
        cancellationRequested: payload.cancellationRequested === true
      }
    };
  });
  return handlers;
}

module.exports = { GATEWAY_OPERATION_SCOPES, createGatewayOperationHandlers };
