const test = require('node:test');
const assert = require('node:assert/strict');

const RuntimeInfrastructureCoordinator =
  require('../../../../src/core/runtime/runtime-infrastructure-coordinator');

test('builds local workflow infrastructure with canonical tenant quota policy', () => {
  const scheduler = {
    async: false,
    shutdown: () => 'stopped'
  };

  const coordinator = new RuntimeInfrastructureCoordinator({
    workflowScheduler: scheduler,
    tenantId: 'tenant-a',
    maxConcurrent: 2,
    maxQueueDepth: 7,
    maxRetries: 3,
    maxInputChars: 123,
    maxToolInputChars: 456
  });

  assert.equal(coordinator.workflowScheduler, scheduler);
  assert.equal(coordinator.tenantQuotaPolicy.maxConcurrent, 2);
  assert.equal(coordinator.tenantQuotaPolicy.maxQueued, 7);
  assert.equal(coordinator.tenantQuotaPolicy.maxRetries, 3);
  assert.equal(coordinator.tenantQuotaService.scheduler, scheduler);
  assert.equal(coordinator.shutdown(), 'stopped');
});

test('reuses supplied quota policy and quota service', () => {
  const scheduler = { async: true, shutdown: () => null };
  const quotaPolicy = {
    maxConcurrent: 4,
    maxQueued: 9,
    toJSON: () => ({ maxConcurrent: 4 })
  };
  const quotaService = { scheduler: null };

  const coordinator = new RuntimeInfrastructureCoordinator({
    workflowScheduler: scheduler,
    tenantId: 'tenant-b',
    quotaPolicy,
    quotaService
  });

  assert.equal(coordinator.tenantQuotaPolicy, quotaPolicy);
  assert.equal(coordinator.tenantQuotaService, quotaService);
  assert.equal(coordinator.tenantQuotaService.scheduler, scheduler);
  assert.equal(scheduler.quotaPolicy, quotaPolicy);
});
