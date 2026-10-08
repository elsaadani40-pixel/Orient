const test = require('node:test');
const assert = require('node:assert/strict');

const RequestExecutionCoordinator = require('../../../../src/core/runtime/request-execution-coordinator');
const AgentState = require('../../../../src/core/agent/state/agent-state');

test('preserves plan identity validation and response classification', () => {
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {},
    recoveryCoordinator: { fail: async () => {} },
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


test('reconciles a terminal durable execution instead of replaying an active checkpoint', async () => {
  let executionAttempts = 0;
  let checkpointSaves = 0;

  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {
      run: async () => {
        executionAttempts += 1;
        throw new Error('resume must not execute');
      }
    },
    recoveryCoordinator: {},
    persistence: {
      executions: {
        findById: () => ({
          executionId: 'execution-terminal',
          requestId: 'request-terminal',
          goalId: 'goal-terminal',
          tenantId: 'tenant-a',
          metadata: { tenantId: 'tenant-a' },
          input: 'already completed',
          status: 'completed',
          agentLifecycle: 'completed',
          result: { value: 'durable' }
        })
      },
      checkpoints: {
        findLatest: () => ({
          checkpointId: 'checkpoint-active',
          sequence: 4,
          snapshot: {
            executionId: 'execution-terminal',
            requestId: 'request-terminal',
            goalId: 'goal-terminal',
            tenantId: 'tenant-a',
            metadata: { tenantId: 'tenant-a' },
            input: 'already completed',
            status: 'running',
            agentLifecycle: 'executing',
            plan: { intent: 'test', steps: [{ step: 1, tool: 'test.tool' }] },
            events: []
          },
          snapshotSha256: null
        }),
        save: (snapshot, options) => {
          checkpointSaves += 1;
          assert.equal(snapshot.status, 'completed');
          assert.equal(options.reason, 'recovery_reconciled_terminal');
          return snapshot;
        }
      }
    },
    persistenceCoordinator: {},
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    userId: 'user-a',
    workspaceId: 'workspace-a',
    maxInputChars: 1000
  });

  const result = await coordinator.resume('execution-terminal');

  assert.equal(result.resumed, false);
  assert.equal(result.reason, 'execution_already_terminal');
  assert.equal(result.reconciled, true);
  assert.equal(result.execution.status, 'completed');
  assert.equal(executionAttempts, 0);
  assert.equal(checkpointSaves, 1);
});


test('forwards request-local approval collection to execution without corrupting it', async () => {
  let received = null;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'test', steps: [{ step: 1, tool: 'test.tool' }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'test.tool' }] }
      })
    },
    agentExecutionCoordinator: {
      run: async (args) => {
        received = args;
        args.context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
        args.context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);
        args.context.transitionAgentTo(AgentState.LIFECYCLE.OBSERVING);
        args.context.transitionAgentTo(AgentState.LIFECYCLE.EVALUATING);
        return {
          plan: args.plan,
          loopResult: { result: { ok: true }, evaluation: { success: true } },
          replanningDecision: { toJSON: () => ({ replanned: false }) }
        };
      }
    },
    recoveryCoordinator: { fail: async () => {} },
    persistence: null,
    persistenceCoordinator: {
      persistExecution: async () => {},
      persistEvents: async () => {}
    },
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    userId: 'user-a',
    workspaceId: 'workspace-a',
    maxInputChars: 1000
  });

  const approvals = { 1: { approvalId: 'approval-1' } };
  await coordinator.execute('run approved tool', { approvals });

  assert.strictEqual(received.approvals, approvals);
  assert.equal(received.requestId.length > 0, true);
  assert.equal(received.input, 'run approved tool');
  assert.equal(received.tenantId, 'tenant-a');
});
