'use strict';

const { DEFAULT_OPERATION_SCOPES } = require('./owner-session-identity-authority');

function reject(code) {
  throw Object.assign(new Error('Gateway execution authorization rejected'), { code });
}

class GatewayIdentityExecutionService {
  constructor({ tokenVerifier, gatewayIdentityRepository, operationScopes = DEFAULT_OPERATION_SCOPES, sessionAuthorizer = null } = {}) {
    if (!tokenVerifier || typeof tokenVerifier.verify !== 'function') {
      throw new TypeError('A configured identity token verifier is required');
    }
    if (!gatewayIdentityRepository || typeof gatewayIdentityRepository.executeAtomically !== 'function') {
      throw new TypeError('A durable gateway identity repository is required');
    }
    const entries = operationScopes instanceof Map
      ? [...operationScopes.entries()]
      : Object.entries(operationScopes || {});
    if (!entries.length || entries.some(([operation, scope]) =>
      typeof operation !== 'string' || !operation.trim() ||
      typeof scope !== 'string' || !scope.trim()
    )) throw new TypeError('Gateway operation scope policy is invalid');

    if (sessionAuthorizer !== null && typeof sessionAuthorizer !== 'function') {
      throw new TypeError('A session authorization callback is required when configured');
    }
    this.tokenVerifier = tokenVerifier;
    this.gatewayIdentityRepository = gatewayIdentityRepository;
    this.operationScopes = new Map(entries);
    this.sessionAuthorizer = sessionAuthorizer;
  }

  async execute({
    token,
    challengeId,
    operation,
    operationId,
    requestId,
    idempotencyKey,
    request,
    execute,
    ownerSessionId
  } = {}) {
    const requiredScope = this.operationScopes.get(operation);
    if (!requiredScope) reject('GATEWAY_OPERATION_DENIED');
    if (typeof token !== 'string' || !token ||
        typeof challengeId !== 'string' || typeof operationId !== 'string' ||
        typeof requestId !== 'string' || typeof idempotencyKey !== 'string' ||
        !idempotencyKey.trim() || idempotencyKey.length > 200 ||
        typeof execute !== 'function') {
      reject('GATEWAY_EXECUTION_INPUT_INVALID');
    }

    const verified = this.tokenVerifier.verify(token, {
      challenge_id: challengeId,
      operation,
      operation_id: operationId,
      request_id: requestId,
      requiredScope
    });
    if (!verified || verified.scope.length !== 1 || verified.scope[0] !== requiredScope) {
      reject('GATEWAY_SCOPE_POLICY_REJECTED');
    }
    if (this.sessionAuthorizer) {
      if (typeof ownerSessionId !== 'string' || ownerSessionId !== verified.session_id ||
          !await this.sessionAuthorizer({ ownerId: verified.owner_id, sessionId: verified.session_id })) {
        reject('GATEWAY_SESSION_REJECTED');
      }
    }

    const principal = Object.freeze({
      principalId: verified.owner_id,
      ownerId: verified.owner_id,
      tenantId: verified.tenant_id,
      workspaceId: verified.workspace_id,
      authSource: 'orient-owner-session',
      sessionId: verified.session_id
    });
    const binding = Object.freeze({
      ownerId: verified.owner_id,
      sessionId: verified.session_id,
      tenantId: verified.tenant_id,
      workspaceId: verified.workspace_id,
      challengeId: verified.challenge_id,
      operation: verified.operation,
      operationId: verified.operation_id,
      requestId: verified.request_id
    });

    return this.gatewayIdentityRepository.executeAtomically({
      principal,
      binding,
      idempotencyKey,
      request,
      execute: client => execute(client, { principal, binding, request })
    });
  }
}

module.exports = { GatewayIdentityExecutionService };
