const test = require('node:test');
const assert = require('node:assert/strict');

const ApprovalService = require('../../../../src/core/agent/approval/approval-service');
const AuthorizationService = require('../../../../src/core/agent/authorization/authorization-service');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

test('execution identity is durable and rejects conflicting metadata', () => {
  const context = new ExecutionContext({
    requestId: 'request-tenant',
    input: 'tenant test',
    tenantId: 'tenant-a',
    userId: 'user-a',
    workspaceId: 'workspace-a'
  });

  const snapshot = context.snapshot();

  assert.equal(snapshot.tenantId, 'tenant-a');
  assert.equal(snapshot.userId, 'user-a');
  assert.equal(snapshot.workspaceId, 'workspace-a');
  assert.equal(snapshot.metadata.tenantId, 'tenant-a');

  assert.throws(
    () => new ExecutionContext({
      requestId: 'request-conflict',
      input: 'tenant test',
      tenantId: 'tenant-a',
      metadata: { tenantId: 'tenant-b' }
    }),
    /Identity metadata mismatch/
  );

  const restored = ExecutionContext.restore(snapshot);
  assert.equal(restored.tenantId, 'tenant-a');
  assert.equal(restored.metadata.tenantId, 'tenant-a');
});

test('approval authorization is isolated by tenant and remains single-use', () => {
  const approvalService = new ApprovalService({
    tenantId: 'tenant-a',
    clock: () => 1000
  });

  const approval = approvalService.issue({
    executionId: 'execution-a',
    step: 1,
    tool: 'mail.send',
    capability: 'communication.send',
    tenantId: 'tenant-a'
  });

  const authorization = new AuthorizationService({
    capabilityMapper: {
      get() { return 'communication.send'; }
    },
    capabilityPolicy: {
      authorize() { return { allowed: true, reason: 'allowed' }; },
      riskOf() { return 'high'; },
      requiresApproval() { return true; }
    },
    approvalService
  });

  const crossTenant = authorization.authorize('mail.send', {
    executionId: 'execution-a',
    step: 1,
    planRevision: 1,
    approval,
    tenantId: 'tenant-b',
    scope: { planRevision: 1 }
  });

  assert.equal(crossTenant.allowed, false);
  assert.equal(crossTenant.reason, 'APPROVAL_TENANT_MISMATCH');

  const sameTenant = authorization.authorize('mail.send', {
    executionId: 'execution-a',
    step: 1,
    planRevision: 1,
    approval,
    tenantId: 'tenant-a',
    scope: { planRevision: 1 }
  });

  assert.equal(sameTenant.allowed, true);
  assert.equal(approvalService.consume(approval.approvalId, 'tenant-b'), false);
  assert.equal(approvalService.consume(approval.approvalId, 'tenant-a'), true);
  assert.equal(approvalService.consume(approval.approvalId, 'tenant-a'), false);
});
