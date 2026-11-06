'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_OPERATION_SCOPES = Object.freeze({
  'execution.get': 'execution.read',
  'execution.list': 'execution.read',
  'execution.create': 'execution.write',
  'execution.update': 'execution.write',
  'execution.cancel': 'execution.cancel',
  'approval.get': 'approval.read',
  'approval.decide': 'approval.decide',
  'approval.consume': 'approval.consume'
});

function reject(code) {
  throw Object.assign(new Error('Owner identity authority rejected the request'), { code });
}

/**
 * Signs gateway proofs only from a live OwnerIdentityService session.
 *
 * challengeStore is deliberately an injected gateway-owned repository. Its
 * getForIssuance(challengeId) method must return a persisted, unexpired,
 * unconsumed challenge record. This class does not implement replay
 * consumption; the Gateway must atomically consume the challenge together
 * with its idempotency reservation and protected database mutation.
 */
class OwnerSessionIdentityAuthority {
  constructor({
    ownerIdentity,
    tokenIssuer,
    challengeStore,
    tenantId,
    workspaceId,
    operationScopes = DEFAULT_OPERATION_SCOPES,
    now = Date.now
  } = {}) {
    if (!ownerIdentity || typeof ownerIdentity.authenticate !== 'function' ||
        typeof ownerIdentity.isActiveSession !== 'function') {
      throw new TypeError('A canonical OwnerIdentityService is required');
    }
    if (!tokenIssuer || typeof tokenIssuer.issue !== 'function') {
      throw new TypeError('A configured identity token issuer is required');
    }
    if (!challengeStore || typeof challengeStore.getForIssuance !== 'function') {
      throw new TypeError('A gateway challenge repository is required');
    }
    for (const [name, value] of [['tenantId', tenantId], ['workspaceId', workspaceId]]) {
      if (typeof value !== 'string' || !value.trim() || value.length > 128) {
        throw new TypeError(name + ' must be a non-empty string of at most 128 characters');
      }
    }
    if (typeof now !== 'function') throw new TypeError('A clock function is required');

    const entries = operationScopes instanceof Map
      ? [...operationScopes.entries()]
      : Object.entries(operationScopes);
    if (!entries.length || entries.some(([operation, scope]) =>
      typeof operation !== 'string' || !operation.trim() || operation.length > 128 ||
      typeof scope !== 'string' || !scope.trim() || scope.length > 128
    )) {
      throw new TypeError('Operation scope policy is invalid');
    }

    this.ownerIdentity = ownerIdentity;
    this.tokenIssuer = tokenIssuer;
    this.challengeStore = challengeStore;
    this.tenantId = tenantId;
    this.workspaceId = workspaceId;
    this.operationScopes = new Map(entries);
    this.now = now;
  }

  async issueForSession({ ownerSessionToken, challengeId, operation, operationId, requestId } = {}) {
    if (typeof ownerSessionToken !== 'string' || !ownerSessionToken) {
      reject('IDENTITY_AUTH_SESSION_REQUIRED');
    }
    if (!UUID.test(challengeId || '') || !UUID.test(operationId || '') ||
        !UUID.test(requestId || '') || typeof operation !== 'string' || !operation.trim()) {
      reject('IDENTITY_AUTH_BINDING_INVALID');
    }

    const requiredScope = this.operationScopes.get(operation);
    if (!requiredScope) reject('IDENTITY_AUTH_OPERATION_DENIED');

    const session = this.ownerIdentity.authenticate(ownerSessionToken);
    if (!session || !UUID.test(session.ownerId || '') || !UUID.test(session.sessionId || '') ||
        !this.ownerIdentity.isActiveSession(session.sessionId)) {
      reject('IDENTITY_AUTH_SESSION_REJECTED');
    }

    const principal = Object.freeze({
      principalId: session.ownerId,
      ownerId: session.ownerId,
      tenantId: this.tenantId,
      workspaceId: this.workspaceId,
      authSource: 'orient-owner-session',
      sessionId: session.sessionId
    });
    const challenge = await this.challengeStore.getForIssuance(challengeId, { principal });
    const now = this.now();
    if (!challenge || challenge.challengeId !== challengeId ||
        challenge.status !== 'ISSUED' ||
        !/^[a-f0-9]{64}$/.test(challenge.requestFingerprint || '') ||
        !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= now) {
      reject('IDENTITY_AUTH_CHALLENGE_REJECTED');
    }
    if (challenge.ownerId !== session.ownerId ||
        challenge.sessionId !== session.sessionId ||
        challenge.tenantId !== this.tenantId ||
        challenge.workspaceId !== this.workspaceId ||
        challenge.operation !== operation ||
        challenge.operationId !== operationId ||
        challenge.requestId !== requestId) {
      reject('IDENTITY_AUTH_CHALLENGE_BINDING_MISMATCH');
    }

    return Object.freeze({
      token: this.tokenIssuer.issue({
        principal,
        challengeId,
        operation,
        operationId,
        requestId,
        scope: [requiredScope]
      }),
      requiredScope
    });
  }
}

module.exports = {
  OwnerSessionIdentityAuthority,
  DEFAULT_OPERATION_SCOPES
};
