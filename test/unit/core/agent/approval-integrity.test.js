const test = require('node:test');
const assert = require('node:assert/strict');

const ApprovalService = require('../../../../src/core/agent/approval/approval-service');
const AuthorizationService = require('../../../../src/core/agent/authorization/authorization-service');
const CapabilityMapper = require('../../../../src/core/agent/capability/capability-mapper');
const PolicyEngine = require('../../../../src/core/agent/policy/policy-engine');

function authorizationFixture() {
  const approvals = new ApprovalService({ tenantId: 'tenant-a' });
  const auth = new AuthorizationService({
    capabilityMapper: new CapabilityMapper({
      mappings: { 'danger.write': 'external.write' }
    }),
    capabilityPolicy: new PolicyEngine({
      capabilities: ['external.write'],
      riskByCapability: { 'external.write': 'high' }
    }),
    approvalService: approvals
  });
  return { approvals, auth };
}

test('approval is bound to the issuing agent identity', async () => {
  const { approvals, auth } = authorizationFixture();
  const approval = await approvals.issue({
    executionId: 'exec-agent-bound',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    tenantId: 'tenant-a',
    agentId: 'PROJECT_BUILDER_AGENT',
    operationId: 'op-agent-bound'
  });

  const allowed = await auth.authorize('danger.write', {
    executionId: 'exec-agent-bound',
    step: 1,
    planRevision: 1,
    approval,
    tenantId: 'tenant-a',
    agentId: 'PROJECT_BUILDER_AGENT',
    operationId: 'op-agent-bound'
  });
  assert.equal(allowed.allowed, true);

  const wrongAgent = await auth.authorize('danger.write', {
    executionId: 'exec-agent-bound',
    step: 1,
    planRevision: 1,
    approval,
    tenantId: 'tenant-a',
    agentId: 'OTHER_AGENT',
    operationId: 'op-agent-bound'
  });
  assert.equal(wrongAgent.allowed, false);
  assert.equal(wrongAgent.reason, 'APPROVAL_AGENT_MISMATCH');
});

test('approval is bound to the canonical operation identity', async () => {
  const { approvals, auth } = authorizationFixture();
  const approval = await approvals.issue({
    executionId: 'exec-operation-bound',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    tenantId: 'tenant-a',
    agentId: 'PROJECT_BUILDER_AGENT',
    operationId: 'op-canonical'
  });

  const wrongOperation = await auth.authorize('danger.write', {
    executionId: 'exec-operation-bound',
    step: 1,
    planRevision: 1,
    approval,
    tenantId: 'tenant-a',
    agentId: 'PROJECT_BUILDER_AGENT',
    operationId: 'op-tampered'
  });
  assert.equal(wrongOperation.allowed, false);
  assert.equal(wrongOperation.reason, 'APPROVAL_OPERATION_MISMATCH');

  const allowed = await auth.authorize('danger.write', {
    executionId: 'exec-operation-bound',
    step: 1,
    planRevision: 1,
    approval,
    tenantId: 'tenant-a',
    agentId: 'PROJECT_BUILDER_AGENT',
    operationId: 'op-canonical'
  });
  assert.equal(allowed.allowed, true);
});

test('unbound legacy approvals fail closed when the runtime supplies an agent binding', async () => {
  const { approvals, auth } = authorizationFixture();
  const approval = await approvals.issue({
    executionId: 'exec-legacy',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    tenantId: 'tenant-a'
  });

  const checked = await auth.authorize('danger.write', {
    executionId: 'exec-legacy',
    step: 1,
    planRevision: 1,
    approval,
    tenantId: 'tenant-a',
    agentId: 'PROJECT_BUILDER_AGENT',
    operationId: 'op-runtime'
  });
  assert.equal(checked.allowed, false);
  assert.equal(checked.reason, 'APPROVAL_AGENT_MISMATCH');
});
