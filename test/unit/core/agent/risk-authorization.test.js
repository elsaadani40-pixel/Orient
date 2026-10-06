const test = require('node:test');
const assert = require('node:assert/strict');

const CapabilityMapper = require('../../../../src/core/agent/capability/capability-mapper');
const PolicyEngine = require('../../../../src/core/agent/policy/policy-engine');
const AuthorizationService = require('../../../../src/core/agent/authorization/authorization-service');
const ApprovalService = require('../../../../src/core/agent/approval/approval-service');

test('high risk capability requires matching single use approval', () => {
  const mapper = new CapabilityMapper({
    mappings: { 'danger.write': 'external.write' }
  });

  const policy = new PolicyEngine({
    capabilities: ['external.write'],
    riskByCapability: { 'external.write': 'high' }
  });

  const approvals = new ApprovalService();
  const auth = new AuthorizationService({
    capabilityMapper: mapper,
    capabilityPolicy: policy,
    approvalService: approvals
  });

  const denied = auth.authorize('danger.write', {
    executionId: 'exec-1',
    step: 1,
    scope: { planRevision: 1 }
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'APPROVAL_REQUIRED');

  const approval = approvals.issue({
    executionId: 'exec-1',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { planRevision: 1 }
  });

  const allowed = auth.authorize('danger.write', {
    executionId: 'exec-1',
    step: 1,
    approval,
    scope: { planRevision: 1 }
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.risk, 'high');

  assert.equal(approvals.consume(approval.approvalId), true);

  const replay = auth.authorize('danger.write', {
    executionId: 'exec-1',
    step: 1,
    approval,
    scope: { planRevision: 1 }
  });
  assert.equal(replay.allowed, false);
  assert.equal(replay.reason, 'APPROVAL_ALREADY_USED');
});
