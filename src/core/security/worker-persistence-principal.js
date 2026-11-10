'use strict';

const issuedPrincipals = new WeakSet();

function validateIdentifier(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new TypeError(field + ' must be a non-empty identifier of at most 200 characters'), {
      code: 'WORKER_PERSISTENCE_PRINCIPAL_INVALID'
    });
  }
  return value;
}

/**
 * Trusted in-process identity for a worker persistence operation.
 * A lease-bound principal must be minted only after the scheduler has acquired
 * the durable workflow lease; repositories still verify that lease in SQL.
 */
function createWorkerPersistencePrincipal({
  tenantId,
  workerId,
  sessionId,
  capabilities = [],
  workflowId = null,
  leaseId = null,
  fencingToken = null
} = {}) {
  const principal = {
    kind: 'worker',
    tenantId: validateIdentifier(tenantId, 'tenantId'),
    workerId: validateIdentifier(workerId, 'workerId'),
    sessionId: validateIdentifier(sessionId, 'sessionId'),
    capabilities: Object.freeze([...new Set(
      (Array.isArray(capabilities) ? capabilities : [])
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim())
    )].sort())
  };

  const leaseFields = [workflowId, leaseId, fencingToken];
  const hasLeaseBinding = leaseFields.some(value => value !== null && value !== undefined);
  if (hasLeaseBinding) {
    if (leaseFields.some(value => value === null || value === undefined)) {
      throw Object.assign(new TypeError('workflowId, leaseId, and fencingToken must be supplied together'), {
        code: 'WORKER_PERSISTENCE_LEASE_BINDING_INVALID'
      });
    }
    principal.workflowId = validateIdentifier(workflowId, 'workflowId');
    principal.leaseId = validateIdentifier(leaseId, 'leaseId');
    if (!Number.isSafeInteger(Number(fencingToken)) || Number(fencingToken) < 1) {
      throw Object.assign(new TypeError('fencingToken must be a positive safe integer'), {
        code: 'WORKER_PERSISTENCE_LEASE_BINDING_INVALID'
      });
    }
    principal.fencingToken = Number(fencingToken);
  }

  Object.freeze(principal);
  issuedPrincipals.add(principal);
  return principal;
}

function assertWorkerPersistencePrincipal(principal, { requireLease = false } = {}) {
  if (!principal || typeof principal !== 'object' || !issuedPrincipals.has(principal)) {
    throw Object.assign(new TypeError('A trusted worker persistence principal is required'), {
      code: 'WORKER_PERSISTENCE_PRINCIPAL_REQUIRED'
    });
  }
  if (requireLease && (!principal.workflowId || !principal.leaseId || !Number.isSafeInteger(principal.fencingToken))) {
    throw Object.assign(new TypeError('A lease-bound worker persistence principal is required'), {
      code: 'WORKER_PERSISTENCE_LEASE_REQUIRED'
    });
  }
  return principal;
}

module.exports = {
  createWorkerPersistencePrincipal,
  assertWorkerPersistencePrincipal
};
