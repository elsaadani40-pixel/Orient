'use strict';

const issuedPrincipals = new WeakSet();

function validateIdentifier(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new TypeError(`${field} must be a non-empty identifier of at most 200 characters`), {
      code: 'PERSISTENCE_PRINCIPAL_INVALID'
    });
  }
  return value;
}

/**
 * Immutable identity envelope for one authenticated persistence operation.
 * Construct this only after the HTTP/runtime boundary has resolved the
 * authenticated owner session; never populate it from request-body identity
 * fields.
 */
function createPersistencePrincipal({ tenantId, ownerId, sessionId } = {}) {
  const principal = Object.freeze({
    tenantId: validateIdentifier(tenantId, 'tenantId'),
    ownerId: validateIdentifier(ownerId, 'ownerId'),
    sessionId: validateIdentifier(sessionId, 'sessionId')
  });
  issuedPrincipals.add(principal);
  return principal;
}

function assertPersistencePrincipal(principal) {
  if (!principal || typeof principal !== 'object' || !issuedPrincipals.has(principal)) {
    throw Object.assign(new TypeError('A validated persistence principal is required'), {
      code: 'PERSISTENCE_PRINCIPAL_REQUIRED'
    });
  }
  return principal;
}

module.exports = {
  createPersistencePrincipal,
  assertPersistencePrincipal
};
