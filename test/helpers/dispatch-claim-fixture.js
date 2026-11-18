'use strict';

module.exports = function withDispatchClaim(snapshot, {
  workerId = 'worker-a',
  workerSessionId = 'session-a',
  ttlMs = 10000
} = {}) {
  const now = Date.now();
  return {
    ...snapshot,
    dispatchClaim: {
      tenantId: snapshot.tenantId,
      workflowId: snapshot.workflowId,
      workerId,
      workerSessionId,
      claimedAt: new Date(now - 100).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString()
    }
  };
};
