const test = require('node:test');
const assert = require('node:assert/strict');

const RequestExecutionCoordinator = require('../../../../src/core/runtime/request-execution-coordinator');

test('preserves plan identity validation and response classification', () => {
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {},
    recoveryCoordinator: {},
    persistence: null,
    persistenceCoordinator: {},
    quotaService: {},
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    userId: 'user-a',
    workspaceId: 'workspace-a',
    maxInputChars: 100
  });

  const plan = {
    intent: 'memory.search',
    agentId: 'ORIENT_RUNTIME',
    input: { query: 'test' },
    steps: [{ step: 1, tool: 'memory.search', input: { query: 'test' } }]
  };

  const fingerprint = coordinator.planFingerprint(plan);
  assert.equal(coordinator.validateReplannedPlan(plan, fingerprint).valid, false);
  assert.equal(coordinator.resolveResponseType('memory.search'), 'memory_result');
  assert.equal(coordinator.resolveResponseType('tool.execute'), 'tool_result');
});

test('rejects oversized request before orchestration', async () => {
  let orchestrated = false;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {
      plan: async () => {
        orchestrated = true;
      }
    },
    agentExecutionCoordinator: {},
    recoveryCoordinator: {},
    persistence: null,
    persistenceCoordinator: {},
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 3
  });

  const result = await coordinator.execute('abcd');
  assert.equal(result.code, 'INPUT_TOO_LARGE');
  assert.equal(orchestrated, false);
});
