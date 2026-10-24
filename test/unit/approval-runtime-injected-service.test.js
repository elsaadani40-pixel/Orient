const test = require('node:test');
const assert = require('node:assert/strict');

const OrientRuntime = require('../../src/core/runtime/orient-runtime');
const ApprovalService = require('../../src/core/agent/approval/approval-service');

function createRuntime(approvalService, tenantId = 'tenant-a', approvalDecisionAuthorizer = null) {
  return new OrientRuntime({
    toolRegistry: {},
    agentOrchestrator: {},
    approvalService,
    tenantId,
    approvalDecisionAuthorizer
  });
}

test('runtime fails closed without an explicit active-owner decision authorizer', async () => {
  const approvals = new ApprovalService({ tenantId: 'tenant-a' });
  const runtime = createRuntime(approvals);
  const issued = await approvals.issue({
    executionId: 'execution-1',
    step: 1,
    tool: 'calendar.create',
    capability: 'calendar.write',
    tenantId: 'tenant-a'
  });

  await assert.rejects(
    runtime.decideApproval({
      approvalId: issued.approvalId,
      executionId: 'execution-1',
      decision: 'approved',
      actorId: 'public:user-1'
    }),
    error => error.code === 'APPROVAL_DECISION_FORBIDDEN'
  );

  await assert.rejects(
    runtime.decideApproval({
      approvalId: issued.approvalId,
      executionId: 'execution-1',
      decision: 'approved',
      actorId: 'owner:Admin'
    }),
    error => error.code === 'APPROVAL_DECISION_FORBIDDEN'
  );
});

test('runtime accepts an injected decision only when the trusted authorizer approves the active session', async () => {
  const approvals = new ApprovalService({ tenantId: 'tenant-a' });
  const runtime = createRuntime(approvals, 'tenant-a', async ({ actorId }) => actorId === 'session-uuid-1');
  const issued = await approvals.issue({
    executionId: 'execution-authorized',
    step: 1,
    tool: 'calendar.create',
    capability: 'calendar.write',
    tenantId: 'tenant-a'
  });
  const result = await runtime.decideApproval({
    approvalId: issued.approvalId,
    executionId: 'execution-authorized',
    decision: 'approved',
    actorId: 'session-uuid-1'
  });
  assert.equal(result.decision.status, 'approved');
});

test('runtime decision policy rejects approvals belonging to another tenant', async () => {
  const approvals = new ApprovalService({ tenantId: 'tenant-a' });
  const runtime = createRuntime(approvals, 'tenant-a');
  const issued = await approvals.issue({
    executionId: 'execution-2',
    step: 1,
    tool: 'calendar.create',
    capability: 'calendar.write',
    tenantId: 'tenant-b'
  });

  await assert.rejects(
    runtime.decideApproval({
      approvalId: issued.approvalId,
      executionId: 'execution-2',
      decision: 'approved',
      actorId: 'owner:Admin'
    }),
    error => error.code === 'APPROVAL_TENANT_MISMATCH' || error.code === 'APPROVAL_DECISION_FORBIDDEN'
  );
});

test('runtime decision policy rejects conflicting primary and metadata tenant identities', async () => {
  const approvals = new ApprovalService({ tenantId: 'tenant-a' });
  const runtime = createRuntime(approvals, 'tenant-a');

  assert.equal(await runtime.approvalService.decisionAuthorizer({
    actorId: 'owner:Admin',
    tenantId: 'tenant-a',
    approval: {
      tenantId: 'tenant-a',
      metadata: { tenantId: 'tenant-b' }
    }
  }), false);
});
