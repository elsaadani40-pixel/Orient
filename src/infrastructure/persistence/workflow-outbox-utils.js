'use strict';

function validateAcknowledgement(workflowId, tenantId, eventIds) {
  if (!workflowId || !tenantId || !Array.isArray(eventIds) ||
      eventIds.some(id => typeof id !== 'string' || !id)) {
    throw new TypeError('workflowId, tenantId, and eventIds are required');
  }
  return new Set(eventIds);
}

function prepareAcknowledgement(snapshot, acknowledgedIds, now = () => new Date()) {
  const pending = Array.isArray(snapshot.metadata?.pendingPublications)
    ? snapshot.metadata.pendingPublications : [];
  const remaining = pending.filter(event => !acknowledgedIds.has(event.eventId));
  const acknowledged = pending.length - remaining.length;
  const currentRevision = Number(snapshot.checkpoint?.revision || 0);
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
    throw Object.assign(new Error('Workflow checkpoint revision is invalid'), {
      code: 'WORKFLOW_CHECKPOINT_INVALID'
    });
  }
  if (!acknowledged) {
    return {
      updated: null,
      receipt: {
        acknowledged: 0,
        pending: remaining,
        revision: currentRevision,
        lastSavedAt: snapshot.checkpoint?.lastSavedAt || null
      }
    };
  }
  const lastSavedAt = now().toISOString();
  const revision = currentRevision + 1;
  return {
    updated: {
      ...snapshot,
      metadata: { ...snapshot.metadata, pendingPublications: remaining },
      checkpoint: { ...(snapshot.checkpoint || {}), revision, lastSavedAt }
    },
    receipt: { acknowledged, pending: remaining, revision, lastSavedAt }
  };
}

module.exports = { validateAcknowledgement, prepareAcknowledgement };
