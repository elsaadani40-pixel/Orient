const test = require('node:test');
const assert = require('node:assert/strict');
const ApprovalService = require('../../../../src/core/agent/approval/approval-service');

test('approval is single use, scoped and expires', () => {
  let now = 1000;
  const service = new ApprovalService({ clock: () => now });
  const approval = service.issue({
    executionId: 'exec-1',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { planRevision: 1 },
    ttlMs: 100
  });

  assert.equal(service.validate({
    approval, executionId: 'exec-1', step: 1,
    tool: 'danger.write', capability: 'external.write',
    scope: { planRevision: 1 }
  }).allowed, true);

  assert.equal(service.consume(approval.approvalId), true);
  assert.equal(service.validate({
    approval, executionId: 'exec-1', step: 1,
    tool: 'danger.write', capability: 'external.write',
    scope: { planRevision: 1 }
  }).reason, 'APPROVAL_ALREADY_USED');

  const fresh = service.issue({
    executionId: 'exec-1', step: 1, tool: 'danger.write',
    capability: 'external.write', scope: { planRevision: 1 }, ttlMs: 100
  });

  assert.equal(service.validate({
    approval: fresh, executionId: 'exec-1', step: 1,
    tool: 'danger.write', capability: 'external.write',
    scope: { planRevision: 2 }
  }).reason, 'APPROVAL_SCOPE_MISMATCH');

  now += 101;
  assert.equal(service.validate({
    approval: fresh, executionId: 'exec-1', step: 1,
    tool: 'danger.write', capability: 'external.write',
    scope: { planRevision: 1 }
  }).reason, 'APPROVAL_EXPIRED');
});
