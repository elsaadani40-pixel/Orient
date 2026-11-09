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


test('runtime wires optional agent governance services into the execution loop', () => {
  const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');
  const agentInvocationService = { authorize() { return { invocationId: 'test' }; } };
  const capabilityGovernance = { authorizeTool() { return { agentId: 'test', tool: 'test', capability: 'test', risk: 'low' }; } };

  const runtime = new OrientRuntime({
    toolRegistry: { requireAuthorization() {} },
    agentOrchestrator: {
      async plan() {
        return { plan: { steps: [] }, validation: { valid: true, steps: [] } };
      }
    },
    agentInvocationService,
    capabilityGovernance
  });

  assert.equal(runtime.agentLoop.agentInvocationService, agentInvocationService);
  assert.equal(runtime.agentLoop.capabilityGovernance, capabilityGovernance);
  runtime.shutdown({ cancelQueued: false });
});


test('PostgreSQL workflow recovery waits for a trusted worker principal', async () => {
  let recoveryCalls = 0;
  const persistence = {
    isAsync: true,
    db: {},
    workflows: {
      async findAll() { recoveryCalls += 1; return []; },
      async claimQueued() { recoveryCalls += 1; return []; }
    },
    workflowLeases: {},
    tenantQuotas: { async ensureTenant() {} }
  };
  const coordinator = new RuntimeInfrastructureCoordinator({
    persistence,
    tenantId: 'tenant-worker'
  });
  await coordinator.recoveryReady;
  assert.equal(recoveryCalls, 0);
  await coordinator.shutdown();
});


test('runtime composes durable mission recovery into the async workflow scheduler', () => {
  const persistence = {
    isAsync: true,
    db: {},
    events: {
      async findByAggregateId() { return []; },
      async appendMissionEvent() { return null; }
    },
    workflows: {
      async findAll() { return []; },
      async findById() { return null; },
      async repair() { return null; },
      async claimQueued() { return []; },
      async save() {}
    },
    workflowLeases: {},
    tenantQuotas: { async ensureTenant() {} }
  };
  const coordinator = new RuntimeInfrastructureCoordinator({
    persistence,
    tenantId: 'tenant-durable-recovery'
  });
  assert.ok(coordinator.missionEventRecovery);
  assert.equal(coordinator.workflowScheduler.missionEventRecovery, coordinator.missionEventRecovery);
  assert.equal(coordinator.workflowScheduler.missionEventSink, coordinator.missionEventSink);
  coordinator.shutdown();
});
