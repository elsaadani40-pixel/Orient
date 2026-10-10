const test = require('node:test');
const assert = require('node:assert/strict');
const ApprovalService = require('../../../../src/core/agent/approval/approval-service');

test('approval is single use, scoped and expires', async () => {
  let now = 1000;
  const service = new ApprovalService({ clock: () => now, decisionAuthorizer: async () => true });
  const approval = await service.issue({
    executionId: 'exec-1',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { planRevision: 1 },
    ttlMs: 100
  });

  await service.decide({
    approvalId: approval.approvalId, executionId: 'exec-1',
    decision: 'approved', actorId: 'owner-test'
  });
  assert.equal((await service.validate({
    approval, executionId: 'exec-1', step: 1,
    tool: 'danger.write', capability: 'external.write',
    scope: { planRevision: 1 }
  })).allowed, true);

  assert.equal(await service.consume(approval.approvalId), true);
  assert.equal((await service.validate({
    approval, executionId: 'exec-1', step: 1,
    tool: 'danger.write', capability: 'external.write',
    scope: { planRevision: 1 }
  })).reason, 'APPROVAL_ALREADY_USED');

  const fresh = await service.issue({
    executionId: 'exec-1', step: 1, tool: 'danger.write',
    capability: 'external.write', scope: { planRevision: 1 }, ttlMs: 100
  });

  assert.equal((await service.validate({
    approval: fresh, executionId: 'exec-1', step: 1,
    tool: 'danger.write', capability: 'external.write',
    scope: { planRevision: 2 }
  })).reason, 'APPROVAL_SCOPE_MISMATCH');

  now += 101;
  assert.equal((await service.validate({
    approval: fresh, executionId: 'exec-1', step: 1,
    tool: 'danger.write', capability: 'external.write',
    scope: { planRevision: 1 }
  })).reason, 'APPROVAL_EXPIRED');
});


test('durable approval validation ignores stale process-local state', async () => {
  const durable = {
    record: null,
    async save(value) { this.record = { ...value }; },
    async findById() { return this.record ? { ...this.record } : null; },
    async consume() { return false; }
  };
  const service = new ApprovalService({ repository: durable, tenantId: 'tenant-a' });
  const approval = await service.issue({
    executionId: 'exec-2',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    tenantId: 'tenant-a'
  });
  durable.record.used = true;
  const checked = await service.validate({
    approval,
    executionId: 'exec-2',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    tenantId: 'tenant-a'
  });
  assert.equal(checked.allowed, false);
  assert.equal(checked.reason, 'APPROVAL_ALREADY_USED');
});

test('durable approval issue fails closed when persistence fails', async () => {
  const service = new ApprovalService({
    repository: {
      async save() { throw Object.assign(new Error('database unavailable'), { code: 'DB_UNAVAILABLE' }); }
    }
  });
  await assert.rejects(
    () => service.issue({
      executionId: 'exec-3',
      step: 1,
      tool: 'danger.write',
      capability: 'external.write'
    }),
    error => error.code === 'DB_UNAVAILABLE'
  );
});


test('expired approval cannot be consumed after validation', async () => {
  let now = 5000;
  const service = new ApprovalService({ clock: () => now, decisionAuthorizer: async () => true });
  const approval = await service.issue({
    executionId: 'exec-expiry',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    ttlMs: 100
  });
  await service.decide({ approvalId: approval.approvalId, executionId: 'exec-expiry', decision: 'approved', actorId: 'owner-test' });

  assert.equal((await service.validate({
    approval,
    executionId: 'exec-expiry',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write'
  })).allowed, true);

  now += 101;
  assert.equal(await service.consume(approval.approvalId), false);
});

test('pending approvals expose bounded review summaries without exposing arbitrary metadata', async () => {
  const service = new ApprovalService({ clock: () => 1000 });
  await service.issue({
    executionId: 'exec-review',
    step: 1,
    tool: 'project.execute_change',
    capability: 'workspace.write',
    tenantId: 'tenant-review',
    metadata: {
      approvalSummary: {
        kind: 'file_change',
        changeCount: 1,
        changes: [{
          action: 'update',
          path: 'src/example.js',
          expectedContentSha256: 'a'.repeat(64),
          proposedContentSha256: 'b'.repeat(64),
          contentBytes: 40000,
          lineCount: 2,
          proposedContent: 'x'.repeat(40000),
          contentTruncated: true
        }]
      },
      privateInternalField: 'must not be returned'
    }
  });

  const pending = await service.listPending({ tenantId: 'tenant-review' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].summary.kind, 'file_change');
  assert.equal(pending[0].summary.changes[0].path, 'src/example.js');
  assert.equal(pending[0].summary.changes[0].proposedContent.length, 32000);
  assert.equal(Object.hasOwn(pending[0], 'privateInternalField'), false);

  const forExecution = await service.listForExecution({ executionId: 'exec-review', tenantId: 'tenant-review' });
  assert.equal(forExecution[0].summary.kind, 'file_change');
});

test('approval decisions require authorization and persist one immutable tenant-scoped decision', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const ApprovalRepository = require('../../../../src/infrastructure/persistence/json/approval.repository');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-decision-'));
  try {
    const repository = new ApprovalRepository(path.join(dir, 'approvals.json'));
    let authorized = true;
    const service = new ApprovalService({
      repository,
      tenantId: 'tenant-a',
      clock: () => 1000,
      decisionAuthorizer: async ({ actorId, tenantId }) => authorized && actorId === 'owner-a' && tenantId === 'tenant-a'
    });
    const approval = await service.issue({
      executionId: 'exec-decision',
      step: 1,
      tool: 'danger.write',
      capability: 'external.write',
      tenantId: 'tenant-a',
      ttlMs: 10000
    });

    authorized = false;
    await assert.rejects(
      () => service.decide({ approvalId: approval.approvalId, executionId: 'exec-decision', decision: 'approved', actorId: 'owner-a', tenantId: 'tenant-a' }),
      error => error.code === 'APPROVAL_DECISION_FORBIDDEN'
    );
    assert.equal((await repository.findById(approval.approvalId, { tenantId: 'tenant-a' })).decision, undefined);

    authorized = true;
    const decided = await service.decide({
      approvalId: approval.approvalId, executionId: 'exec-decision', decision: 'approved', actorId: 'owner-a', tenantId: 'tenant-a'
    });
    assert.equal(decided.decision.status, 'approved');
    assert.equal(decided.decision.actorId, 'owner-a');

    const replay = await service.decide({
      approvalId: approval.approvalId, executionId: 'exec-decision', decision: 'approved', actorId: 'owner-a', tenantId: 'tenant-a'
    });
    assert.equal(replay.decision.status, 'approved');
    assert.equal(replay.idempotent, true);

    await assert.rejects(
      () => service.decide({ approvalId: approval.approvalId, executionId: 'exec-decision', decision: 'rejected', actorId: 'owner-a', tenantId: 'tenant-a' }),
      error => error.code === 'APPROVAL_DECISION_CONFLICT'
    );
    await assert.rejects(
      () => service.decide({ approvalId: approval.approvalId, executionId: 'exec-decision', decision: 'approved', actorId: 'owner-b', tenantId: 'tenant-b' }),
      error => error.code === 'APPROVAL_NOT_FOUND' || error.code === 'APPROVAL_TENANT_MISMATCH'
    );

    const persisted = await repository.findById(approval.approvalId, { tenantId: 'tenant-a' });
    assert.equal(persisted.decision.status, 'approved');
    assert.equal(persisted.decision.actorId, 'owner-a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approval decision fails closed when no decision authorizer is configured', async () => {
  const service = new ApprovalService({ tenantId: 'tenant-a', clock: () => 1000 });
  const approval = await service.issue({
    executionId: 'exec-no-authorizer', step: 1, tool: 'danger.write',
    capability: 'external.write', tenantId: 'tenant-a', ttlMs: 10000
  });
  await assert.rejects(
    () => service.decide({ approvalId: approval.approvalId, executionId: 'exec-no-authorizer', decision: 'approved', actorId: 'owner-a', tenantId: 'tenant-a' }),
    error => error.code === 'APPROVAL_DECISION_FORBIDDEN'
  );
});

