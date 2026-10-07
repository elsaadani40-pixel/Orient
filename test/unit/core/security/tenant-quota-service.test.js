const assert = require('node:assert/strict');
const test = require('node:test');

const TenantQuotaPolicy = require('../../../../src/core/security/tenant-quota-policy');
const TenantQuotaService = require('../../../../src/core/security/tenant-quota-service');

test('tenant quota policy rejects invalid limits', () => {
  assert.throws(
    () => new TenantQuotaPolicy({ maxConcurrent: 0 }),
    (error) => error.code === 'TENANT_QUOTA_INVALID'
  );

  assert.throws(
    () => new TenantQuotaPolicy({ maxRetries: -1 }),
    (error) => error.code === 'TENANT_QUOTA_INVALID'
  );
});

test('tenant quota service enforces canonical tenant identity', () => {
  const service = new TenantQuotaService({ tenantId: 'tenant-a' });

  assert.throws(
    () => service.assertTenant('tenant-b'),
    (error) => error.code === 'TENANT_QUOTA_TENANT_MISMATCH'
  );
});

test('tenant quota service enforces input boundaries', () => {
  const service = new TenantQuotaService({
    tenantId: 'tenant-a',
    policy: {
      maxInputChars: 5,
      maxToolInputChars: 4
    }
  });

  assert.deepEqual(service.assertInputSize('12345'), {
    inputChars: 5,
    maxInputChars: 5,
    maxToolInputChars: 4
  });

  assert.throws(
    () => service.assertInputSize('123456'),
    (error) => error.code === 'TENANT_INPUT_QUOTA_EXCEEDED'
  );

  assert.throws(
    () => service.assertInputSize('12345', '12345'),
    (error) => error.code === 'TENANT_TOOL_INPUT_QUOTA_EXCEEDED'
  );
});

test('tenant quota service enforces scheduler concurrency and queue limits', () => {
  const scheduler = {
    depth: () => 2,
    activeCount: () => 1
  };

  const service = new TenantQuotaService({
    tenantId: 'tenant-a',
    scheduler,
    policy: {
      maxConcurrent: 1,
      maxQueued: 2
    }
  });

  assert.throws(
    () => service.assertWorkflowAdmission(),
    (error) => error.code === 'TENANT_CONCURRENCY_QUOTA_EXCEEDED'
  );

  scheduler.activeCount = () => 0;
  scheduler.depth = () => 1;
  assert.deepEqual(service.assertWorkflowAdmission(), {
    allowed: true,
    queued: 1,
    active: 0,
    limits: {
      maxConcurrent: 1,
      maxQueued: 2
    }
  });

  scheduler.depth = () => 2;
  assert.throws(
    () => service.assertWorkflowAdmission(),
    (error) => error.code === 'TENANT_QUEUE_QUOTA_EXCEEDED'
  );
});

test('tenant quota snapshot is tenant-scoped and observable', () => {
  const service = new TenantQuotaService({
    tenantId: 'tenant-a',
    policy: { maxConcurrent: 2, maxQueued: 5 }
  });

  assert.deepEqual(service.snapshot(), {
    tenantId: 'tenant-a',
    policy: {
      maxConcurrent: 2,
      maxQueued: 5,
      maxInputChars: 100000,
      maxToolInputChars: 50000,
      maxRetries: 2
    },
    scheduler: null
  });
});
