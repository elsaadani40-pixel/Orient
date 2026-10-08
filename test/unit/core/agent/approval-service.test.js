const test = require('node:test');
const assert = require('node:assert/strict');
const ApprovalService = require('../../../../src/core/agent/approval/approval-service');

test('approval is single use, scoped and expires', async () => {
  let now = 1000;
  const service = new ApprovalService({ clock: () => now });
  const approval = await service.issue({
    executionId: 'exec-1',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { planRevision: 1 },
    ttlMs: 100
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
  const service = new ApprovalService({ clock: () => now });
  const approval = await service.issue({
    executionId: 'exec-expiry',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    ttlMs: 100
  });

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
