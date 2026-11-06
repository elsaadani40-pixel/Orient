'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reject(code, statusCode = 400) {
  throw Object.assign(new Error('Gateway identity request rejected'), { code, statusCode });
}

function createGatewayIdentityRoutes({ repository, authority, tenantId, workspaceId, now = Date.now, challengeTtlMs = 30000 } = {}) {
  if (!repository || typeof repository.issue !== 'function' ||
      !authority || typeof authority.issueForSession !== 'function' ||
      typeof tenantId !== 'string' || !tenantId.trim() ||
      typeof workspaceId !== 'string' || !workspaceId.trim() ||
      typeof now !== 'function' || !Number.isSafeInteger(challengeTtlMs) ||
      challengeTtlMs < 1000 || challengeTtlMs > 60000) {
    throw new TypeError('Invalid Gateway identity route dependencies');
  }

  async function createChallenge({ ownerSession, operation } = {}) {
    if (!ownerSession?.principal || !UUID.test(ownerSession.ownerId || '') ||
        !UUID.test(ownerSession.sessionId || '')) reject('IDENTITY_AUTH_SESSION_REJECTED', 401);
    if (typeof operation !== 'string' || !authority.operationScopes.has(operation)) {
      reject('IDENTITY_AUTH_OPERATION_DENIED', 403);
    }
    const issuedAt = now();
    if (!Number.isSafeInteger(issuedAt)) throw new TypeError('Gateway clock must return an integer timestamp');
    const challenge = Object.freeze({
      challengeId: crypto.randomUUID(),
      ownerId: ownerSession.ownerId,
      sessionId: ownerSession.sessionId,
      tenantId,
      workspaceId,
      operation,
      operationId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      expiresAt: issuedAt + challengeTtlMs
    });
    await repository.issue(challenge, { principal: ownerSession.principal });
    return Object.freeze({
      challengeId: challenge.challengeId,
      operation: challenge.operation,
      operationId: challenge.operationId,
      requestId: challenge.requestId,
      expiresAt: challenge.expiresAt
    });
  }

  async function issueToken({ ownerSessionToken, challengeId, operation, operationId, requestId } = {}) {
    if (typeof challengeId !== 'string' || !UUID.test(challengeId) ||
        typeof operationId !== 'string' || !UUID.test(operationId) ||
        typeof requestId !== 'string' || !UUID.test(requestId) ||
        typeof operation !== 'string') reject('IDENTITY_AUTH_BINDING_INVALID');
    const result = await authority.issueForSession({
      ownerSessionToken, challengeId, operation, operationId, requestId
    });
    return Object.freeze({ token: result.token, requiredScope: result.requiredScope });
  }

  return Object.freeze({ createChallenge, issueToken });
}

module.exports = { createGatewayIdentityRoutes };
