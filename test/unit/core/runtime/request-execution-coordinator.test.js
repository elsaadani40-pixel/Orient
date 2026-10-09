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
        findById: async () => ({
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
        findLatest: async () => ({
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
        save: async (snapshot, options) => {
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


test('resume returns durable cancellation when cancellation wins terminal completion commit', async () => {
  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const context = new ExecutionContext({
    requestId: 'request-resume-race',
    input: 'resume task',
    executionId: 'execution-resume-race',
    tenantId: 'tenant-a'
  });
  context.start();
  context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
  context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
  context.setPlan({
    intent: 'test.resume-race',
    steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }]
  });
  context.metadata.planRevision = 1;
  context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);

  const snapshot = context.snapshot();
  const writes = [];
  let releaseCount = 0;
  const durableCancelled = {
    ...snapshot,
    status: 'cancelled',
    cancellationRequested: true,
    cancellationReason: 'operator requested cancellation'
  };

  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {
      run: async ({ context: resumedContext }) => {
        resumedContext.transitionAgentTo(AgentState.LIFECYCLE.OBSERVING);
        resumedContext.transitionAgentTo(AgentState.LIFECYCLE.EVALUATING);
        return {
          loopResult: { result: { ok: true }, evaluation: { success: true } },
          replanningDecision: { toJSON: () => ({ outcome: 'done' }) }
        };
      }
    },
    recoveryCoordinator: { fail: async () => {} },
    persistence: {
      executions: {
        findById: () => ({
          ...snapshot,
          status: 'running',
          cancellationRequested: false
        }),
        update: async (id, patch) => ({ ...durableCancelled, ...patch, status: 'cancelled' })
      },
      checkpoints: {
        findLatest: () => ({ checkpointId: 'checkpoint-race', sequence: 1, snapshot }),
        acquireResumeLease: async () => ({ leaseId: 'lease-race' }),
        releaseResumeLease: async () => { releaseCount += 1; },
        save: () => ({ checkpointId: 'checkpoint-cancelled' })
      },
      events: { appendMany: async () => [] }
    },
    persistenceCoordinator: {
      persistExecution: async (ctx) => {
        const persisted = ctx.snapshot();
        if (persisted.status === 'cancelled') {
          writes.push(persisted);
          return { ...durableCancelled, ...persisted };
        }
        return {
          ...persisted,
          status: 'running',
          cancellationRequested: true,
          cancellationReason: 'operator requested cancellation'
        };
      },
      persistEvents: async () => [],
      checkpoint: async () => ({})
    },
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  const result = await coordinator.resume('execution-resume-race');

  assert.equal(result.resumed, false);
  assert.equal(result.reason, 'execution_cancelled');
  assert.equal(result.execution.status, 'cancelled');
  assert.equal(result.execution.cancellationRequested, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'cancelled');
  assert.equal(releaseCount, 1);
});


test('execute returns durable cancellation when cancellation wins terminal completion commit', async () => {
  const writes = [];
  let persistedEvents = [];
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'test.execute-race', steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }] }
      })
    },
    agentExecutionCoordinator: {
      run: async ({ context }) => {
        context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
        context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);
        context.transitionAgentTo(AgentState.LIFECYCLE.OBSERVING);
        context.transitionAgentTo(AgentState.LIFECYCLE.EVALUATING);
        return {
          plan: { intent: 'test.execute-race', steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }] },
          loopResult: { result: { ok: true }, evaluation: { success: true } },
          replanningDecision: { toJSON: () => ({ outcome: 'done' }) }
        };
      }
    },
    recoveryCoordinator: { fail: async () => {} },
    persistence: {
      executions: {
        findById: () => ({ cancellationRequested: false }),
        update: async (id, patch) => ({ ...patch, status: patch.status })
      }
    },
    persistenceCoordinator: {
      persistExecution: async (context, mode) => {
        const snapshot = context.snapshot();
        if (mode === 'insert') return snapshot;
        if (snapshot.status === 'cancelled') {
          writes.push(snapshot);
          return snapshot;
        }
        return {
          ...snapshot,
          status: 'running',
          cancellationRequested: true,
          cancellationReason: 'operator requested cancellation'
        };
      },
      persistEvents: async (context) => {
        persistedEvents = context.events.slice();
        return persistedEvents;
      },
      checkpoint: async () => ({})
    },
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  const result = await coordinator.execute('run the task');

  assert.equal(result.type, 'execution_cancelled');
  assert.equal(result.execution.status, 'cancelled');
  assert.equal(result.execution.cancellationRequested, true);
  assert.equal(result.execution.agentLifecycle, AgentState.LIFECYCLE.CANCELLED);
  assert.equal(persistedEvents.some(event => event.type === 'execution.completed'), false);
  assert.equal(persistedEvents.some(event => event.type === 'execution.cancelled'), true);
  assert.equal(writes.length, 1);
});


test('durable cancellation takes precedence over a concurrent tool failure', async () => {
  let recoveryCalls = 0;
  let persistedEvents = [];
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'test.cancel-error-race', steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }] }
      })
    },
    agentExecutionCoordinator: {
      run: async ({ context }) => {
        context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
        context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);
        context.transitionAgentTo(AgentState.LIFECYCLE.OBSERVING);
        context.transitionAgentTo(AgentState.LIFECYCLE.EVALUATING);
        throw Object.assign(new Error('tool failed after cancellation'), { code: 'TOOL_FAILED' });
      }
    },
    recoveryCoordinator: { fail: async () => { recoveryCalls += 1; } },
    persistence: {
      executions: {
        findById: () => ({
          status: 'running',
          cancellationRequested: true,
          cancellationReason: 'operator requested cancellation'
        })
      }
    },
    persistenceCoordinator: {
      persistExecution: async (context, mode) => context.snapshot(),
      persistEvents: async (context) => {
        persistedEvents = context.events.slice();
        return persistedEvents;
      },
      checkpoint: async () => ({})
    },
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  const result = await coordinator.execute('run the task');

  assert.equal(result.type, 'execution_cancelled');
  assert.equal(result.execution.status, 'cancelled');
  assert.equal(result.execution.cancellationRequested, true);
  assert.equal(recoveryCalls, 0);
  assert.equal(persistedEvents.some(event => event.type === 'execution.failed'), false);
  assert.equal(persistedEvents.some(event => event.type === 'execution.cancelled'), true);
});


test('resume refuses to execute when durable lease acquisition fails', async () => {
  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const context = new ExecutionContext({
    requestId: 'request-no-lease',
    input: 'must not run without lease',
    executionId: 'execution-no-lease',
    tenantId: 'tenant-a'
  });
  context.start();
  context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
  context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
  context.setPlan({
    intent: 'test.no-lease',
    steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }]
  });
  context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);

  let executionAttempts = 0;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {
      run: async () => {
        executionAttempts += 1;
        return {
          loopResult: { result: { ok: true }, evaluation: { success: true } },
          replanningDecision: { toJSON: () => ({ outcome: 'done' }) }
        };
      }
    },
    recoveryCoordinator: { fail: async () => {} },
    persistence: {
      executions: { findById: async () => null },
      checkpoints: {
        findLatest: async () => ({
          checkpointId: 'checkpoint-no-lease',
          sequence: 1,
          snapshot: context.snapshot(),
          snapshotSha256: null
        }),
        acquireResumeLease: async () => null
      }
    },
    persistenceCoordinator: {},
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  await assert.rejects(
    coordinator.resume('execution-no-lease'),
    error => error.code === 'CHECKPOINT_RESUME_LEASE_UNAVAILABLE'
  );
  assert.equal(executionAttempts, 0);
});
