const test = require('node:test');
const assert = require('node:assert/strict');

const RequestExecutionCoordinator = require('../../../../src/core/runtime/request-execution-coordinator');
const AgentState = require('../../../../src/core/agent/state/agent-state');

const CheckpointRepository = require('../../../../src/infrastructure/persistence/json/checkpoint.repository');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
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
        renewResumeLease: async () => ({ leaseId: 'lease-race' }),
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


test('resume lease heartbeat renews during long-running execution and stops cleanly', async () => {
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {},
    recoveryCoordinator: {},
    persistence: null,
    persistenceCoordinator: {},
    quotaService: {},
    quotaPolicy: { toJSON: () => ({}) },
    maxInputChars: 100
  });
  let renewals = 0;
  const heartbeat = coordinator.createResumeLeaseHeartbeat(async () => {
    renewals += 1;
    await new Promise(resolve => setTimeout(resolve, 1));
  }, 5);

  await new Promise(resolve => setTimeout(resolve, 28));
  await heartbeat.stop();
  const stoppedCount = renewals;
  await new Promise(resolve => setTimeout(resolve, 15));

  assert.ok(stoppedCount >= 1, 'heartbeat should renew before a long tool call returns');
  assert.equal(renewals, stoppedCount, 'heartbeat must not renew after stop');
});

test('resume fails closed and releases a lease when renewal is unsupported', async () => {
  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const context = new ExecutionContext({
    requestId: 'request-no-renewal',
    input: 'must not run without renewable lease',
    executionId: 'execution-no-renewal',
    tenantId: 'tenant-a'
  });
  context.start();
  context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
  context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
  context.setPlan({
    intent: 'test.no-renewal',
    steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }]
  });
  context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);

  let executionAttempts = 0;
  let releaseCount = 0;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {
      run: async () => { executionAttempts += 1; }
    },
    recoveryCoordinator: {},
    persistence: {
      executions: { findById: async () => null },
      checkpoints: {
        findLatest: async () => ({
          checkpointId: 'checkpoint-no-renewal',
          sequence: 1,
          snapshot: context.snapshot(),
          snapshotSha256: null
        }),
        acquireResumeLease: async () => ({ leaseId: 'lease-no-renewal' }),
        releaseResumeLease: async () => { releaseCount += 1; }
      }
    },
    persistenceCoordinator: {},
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  await assert.rejects(
    coordinator.resume('execution-no-renewal'),
    error => error.code === 'CHECKPOINT_RESUME_LEASE_RENEWAL_UNSUPPORTED'
  );
  assert.equal(executionAttempts, 0);
  assert.equal(releaseCount, 1);
});

test('resume fails closed before tool execution when a pending approval has no durable approved decision', async () => {
  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const context = new ExecutionContext({
    requestId: 'request-approval-required',
    input: 'perform guarded write',
    executionId: 'execution-approval-required',
    tenantId: 'tenant-a'
  });
  context.start();
  context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
  context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
  context.setPlan({
    intent: 'test.approval-required',
    steps: [{ step: 1, tool: 'danger.write', input: {}, dependsOn: null }]
  });
  context.metadata.planRevision = 1;
  context.metadata.pendingStepInputs = { 1: { approvalRequired: true } };
  context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);

  let executionAttempts = 0;
  let leaseReleases = 0;
  let recoveryFailures = 0;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {
      run: async () => { executionAttempts += 1; }
    },
    recoveryCoordinator: { fail: async () => { recoveryFailures += 1; } },
    persistence: {
      executions: { findById: async () => null },
      checkpoints: {
        findLatest: async () => ({
          checkpointId: 'checkpoint-approval-required',
          sequence: 2,
          snapshot: context.snapshot(),
          snapshotSha256: null
        }),
        acquireResumeLease: async () => ({ leaseId: 'lease-approval-required' }),
        renewResumeLease: async () => ({ leaseId: 'lease-approval-required' }),
        releaseResumeLease: async () => { leaseReleases += 1; }
      }
    },
    persistenceCoordinator: {},
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({}) },
    approvalService: {
      getApprovedForExecution: async () => null,
      findReusable: async () => null
    },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  await assert.rejects(
    coordinator.resume('execution-approval-required'),
    error => error.code === 'APPROVAL_NOT_APPROVED'
  );
  assert.equal(executionAttempts, 0, 'a guarded tool must not run before a durable approval decision');
  assert.equal(recoveryFailures, 0, 'missing approval must not convert a waiting execution into a failed execution');
  assert.equal(leaseReleases, 1, 'the resume lease must be released after fail-closed rejection');
});


test('rejects an inactive owner session before creating a durable execution', async () => {
  let persisted = false;
  let planned = false;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: { plan: async () => { planned = true; } },
    agentExecutionCoordinator: {},
    recoveryCoordinator: {},
    persistence: null,
    persistenceCoordinator: {
      persistExecution: async () => { persisted = true; }
    },
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000,
    ownerSessionAuthorizer: async () => false
  });

  await assert.rejects(
    coordinator.execute('run task', {
      ownerSessionContext: { sessionId: 'revoked-session' }
    }),
    error => error.code === 'OWNER_SESSION_REJECTED'
  );

  assert.equal(persisted, false);
  assert.equal(planned, false);
});

test('records only the verified owner session identity in execution metadata', async () => {
  let persistedMetadata = null;
  let authorizedSessionId = null;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {},
    recoveryCoordinator: {},
    persistence: null,
    persistenceCoordinator: {
      persistExecution: async context => {
        persistedMetadata = { ...context.metadata };
        throw new Error('stop after metadata assertion');
      }
    },
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000,
    ownerSessionAuthorizer: async sessionId => {
      authorizedSessionId = sessionId;
      return sessionId === 'active-session';
    }
  });

  await assert.rejects(
    coordinator.execute('run task', {
      ownerSessionContext: { sessionId: 'active-session' }
    }),
    /stop after metadata assertion/
  );

  assert.equal(authorizedSessionId, 'active-session');
  assert.equal(persistedMetadata.ownerSessionId, 'active-session');
  assert.equal(Object.hasOwn(persistedMetadata, 'csrfToken'), false);
});


test('cancels before the next tool step when the owner session is revoked mid-execution', async () => {
  let sessionChecks = 0;
  let toolRuns = 0;
  let observedReason = null;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'test.owner-session-revocation', steps: [{ step: 1, tool: 'test.tool' }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'test.tool' }] }
      })
    },
    agentExecutionCoordinator: {
      run: async args => {
        const revoked = await args.isCancellationRequested();
        observedReason = args.cancellationReason;
        if (revoked) {
          throw Object.assign(new Error('owner session revoked'), {
            code: 'EXECUTION_CANCELLATION_REQUESTED'
          });
        }
        toolRuns += 1;
        throw new Error('tool should not run');
      }
    },
    recoveryCoordinator: { fail: async () => {} },
    persistence: null,
    persistenceCoordinator: {
      persistExecution: async () => {},
      checkpoint: async () => {},
      persistEvents: async () => {}
    },
    quotaService: {
      assertTenant: () => {},
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000,
    ownerSessionAuthorizer: async () => {
      sessionChecks += 1;
      return sessionChecks === 1;
    }
  });

  const result = await coordinator.execute('run task', {
    ownerSessionContext: { sessionId: 'session-revoked-after-admission' }
  });

  assert.equal(result.type, 'execution_cancelled');
  assert.equal(sessionChecks, 2);
  assert.equal(toolRuns, 0);
  assert.equal(observedReason, 'Owner session is no longer active');
});


test('rejects a revoked owner session before loading a resumable checkpoint', async () => {
  let checkpointReads = 0;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {},
    recoveryCoordinator: {},
    persistence: {
      checkpoints: {
        findLatest: async () => {
          checkpointReads += 1;
          return null;
        }
      }
    },
    persistenceCoordinator: {},
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    maxInputChars: 1000,
    ownerSessionAuthorizer: async () => false
  });

  await assert.rejects(
    coordinator.resume('execution-pending-approval', {
      ownerSessionContext: { sessionId: 'revoked-before-resume' }
    }),
    error => error.code === 'OWNER_SESSION_REJECTED'
  );

  assert.equal(checkpointReads, 0);
});


test('rejects approval challenges that claim a tenant different from the active execution tenant', async () => {
  let approvalIssueCalls = 0;
  let checkpointCalls = 0;
  let eventPersistenceCalls = 0;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'test.cross-tenant-approval', steps: [{ step: 1, tool: 'test.tool' }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'test.tool' }] }
      })
    },
    agentExecutionCoordinator: {
      run: async ({ context }) => {
        throw Object.assign(new Error('approval required'), {
          code: 'APPROVAL_REQUIRED',
          executionContext: {
            executionId: context.executionId,
            step: 1,
            planRevision: 1,
            tool: 'test.tool',
            capability: 'workspace.write',
            tenantId: 'tenant-b',
            input: {}
          }
        });
      }
    },
    recoveryCoordinator: { fail: async () => { throw new Error('recovery must not run'); } },
    persistence: null,
    persistenceCoordinator: {
      persistExecution: async () => ({}),
      checkpoint: async () => { checkpointCalls += 1; },
      persistEvents: async () => { eventPersistenceCalls += 1; }
    },
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({}) },
    approvalService: {
      issue: async () => {
        approvalIssueCalls += 1;
        return { approvalId: 'must-not-be-issued' };
      }
    },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  await assert.rejects(
    coordinator.execute('perform guarded action'),
    error => error.code === 'APPROVAL_TENANT_MISMATCH' && error.statusCode === 403
  );

  assert.equal(approvalIssueCalls, 0, 'no approval may be issued into another tenant');
  assert.equal(checkpointCalls, 0, 'mismatched approval metadata must be rejected before checkpointing');
  assert.equal(eventPersistenceCalls, 0, 'mismatched approval metadata must be rejected before event persistence');
});


test('preserves the owner persistence principal when cancellation wins after failure recovery', async () => {
  const principal = Object.freeze({
    kind: 'owner', tenantId: 'tenant-a', ownerId: 'owner-a',
    sessionId: 'session-a', issuedAt: Date.now()
  });
  let lookupCount = 0;
  const lookupOptions = [];
  const persistCalls = [];
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'test.recovery-cancellation', steps: [{ step: 1, tool: 'test.tool' }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'test.tool' }] }
      })
    },
    agentExecutionCoordinator: {
      run: async () => { throw Object.assign(new Error('tool failed'), { code: 'TOOL_FAILED' }); }
    },
    recoveryCoordinator: { fail: async () => {} },
    persistence: {
      executions: {
        findById: async (_id, options) => {
          lookupOptions.push(options);
          lookupCount += 1;
          if (lookupCount === 1) return null;
          return {
            executionId: 'execution-owner-recovery-race',
            tenantId: 'tenant-a',
            userId: 'owner-a',
            status: 'cancelled',
            cancellationRequested: true,
            cancellationReason: 'owner requested cancellation'
          };
        }
      }
    },
    persistenceCoordinator: {
      persistExecution: async (context, mode, receivedPrincipal) => {
        if (mode === 'insert') return context.snapshot();
        persistCalls.push(['execution', mode, receivedPrincipal]);
        return { status: 'cancelled', cancellationRequested: true };
      },
      persistEvents: async (_context, receivedPrincipal) => {
        persistCalls.push(['events', receivedPrincipal]);
        return [];
      },
      checkpoint: async (_context, _mode, _reason, receivedPrincipal) => {
        persistCalls.push(['checkpoint', receivedPrincipal]);
        return {};
      }
    },
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    userId: 'owner-a',
    workspaceId: 'workspace-a',
    maxInputChars: 1000
  });

  const result = await coordinator.execute('run task', { persistencePrincipal: principal });

  assert.equal(result.type, 'execution_cancelled');
  assert.equal(lookupCount, 2);
  assert.strictEqual(lookupOptions[1].persistencePrincipal, principal);
  assert.deepEqual(persistCalls.map(call => call[0]), ['execution', 'events', 'checkpoint']);
  for (const call of persistCalls) assert.strictEqual(call[call.length - 1], principal);
});

test('resume rejects a caller-supplied approval id without a durable approved decision', async () => {
  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const context = new ExecutionContext({
    requestId: 'request-forged-approval',
    input: 'perform guarded write',
    executionId: 'execution-forged-approval',
    tenantId: 'tenant-a'
  });
  context.start();
  context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
  context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
  context.setPlan({
    intent: 'test.forged-approval',
    steps: [{ step: 1, tool: 'danger.write', input: {}, dependsOn: null }]
  });
  context.metadata.planRevision = 1;
  context.metadata.pendingStepInputs = { 1: { approvalRequired: true } };
  context.startStep({ step: 1, tool: 'danger.write', planRevision: 1 });
  context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);

  let executionAttempts = 0;
  let leaseReleases = 0;
  let reusableLookupCalls = 0;
  let approvalLookupArgs = null;
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {
      run: async () => { executionAttempts += 1; }
    },
    recoveryCoordinator: { fail: async () => { throw new Error('recovery must not run'); } },
    persistence: {
      executions: { findById: async () => null },
      checkpoints: {
        findLatest: async () => ({
          checkpointId: 'checkpoint-forged-approval',
          sequence: 3,
          snapshot: context.snapshot(),
          snapshotSha256: null
        }),
        acquireResumeLease: async () => ({ leaseId: 'lease-forged-approval' }),
        renewResumeLease: async () => ({ leaseId: 'lease-forged-approval' }),
        releaseResumeLease: async () => { leaseReleases += 1; }
      }
    },
    persistenceCoordinator: {},
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({}) },
    approvalService: {
      getApprovedForExecution: async args => {
        approvalLookupArgs = args;
        return null;
      },
      findReusable: async () => { reusableLookupCalls += 1; return null; }
    },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  await assert.rejects(
    coordinator.resume('execution-forged-approval', {
      approval: { approvalId: 'caller-supplied-unverified-id' }
    }),
    error => error.code === 'APPROVAL_NOT_APPROVED'
  );

  assert.deepEqual(approvalLookupArgs, {
    approvalId: 'caller-supplied-unverified-id',
    executionId: 'execution-forged-approval',
    tenantId: 'tenant-a'
  });
  assert.equal(executionAttempts, 0, 'unverified approval must never reach tool execution');
  assert.equal(reusableLookupCalls, 0, 'explicit approval IDs must be verified, not replaced by a reusable lookup');
  assert.equal(leaseReleases, 1, 'the resume lease must be released after rejecting an unverified approval');
});

test("resume does not release a replacement worker's lease after losing ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-resume-lease-race-'));
  try {
    const executionId = 'execution-replaced-lease';
    const tenantId = 'tenant-a';
    const context = new (require('../../../../src/core/execution/execution-context'))({
      requestId: 'request-replaced-lease',
      input: 'resume with a replaced lease',
      executionId,
      tenantId
    });
    context.start();
    context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
    context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
    context.setPlan({
      intent: 'test.replaced-lease',
      steps: [{ step: 1, tool: 'test.tool', input: {}, dependsOn: null }]
    });
    context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);

    const checkpoints = new CheckpointRepository(path.join(root, 'checkpoints.json'));
    checkpoints.save(context.snapshot(), { tenantId });
    let replacementLease = null;
    const coordinator = new RequestExecutionCoordinator({
      agentOrchestrator: {},
      agentExecutionCoordinator: {
        run: async ({ renewResumeLease }) => {
          // Simulate expiry and a new worker acquiring the same execution
          // before this worker's heartbeat attempts to renew its old lease.
          checkpoints.withLock(() => {
            const records = checkpoints.read();
            const lease = records[executionId].resumeLease;
            lease.expiresAtMs = Date.now() - 1;
            lease.expiresAt = new Date(Date.now() - 1).toISOString();
            checkpoints.write(records);
          });
          replacementLease = checkpoints.acquireResumeLease(executionId, {
            tenantId,
            leaseDurationMs: 30000
          });
          await renewResumeLease();
        }
      },
      recoveryCoordinator: { fail: async () => { throw new Error('recovery must not run after lease loss'); } },
      persistence: {
        executions: { findById: async () => null },
        checkpoints
      },
      persistenceCoordinator: {},
      quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
      quotaPolicy: { toJSON: () => ({}) },
      tenantId,
      maxInputChars: 1000,
      resumeLeaseDurationMs: 30000
    });

    await assert.rejects(
      coordinator.resume(executionId),
      error => error.code === 'CHECKPOINT_RESUME_LEASE_LOST'
    );

    assert.ok(replacementLease?.leaseId);
    assert.notEqual(replacementLease.leaseId, undefined);
    const durableCheckpoint = checkpoints.findLatest(executionId, { tenantId });
    assert.equal(
      durableCheckpoint.resumeLease.leaseId,
      replacementLease.leaseId,
      'the old worker must not delete the newer worker lease'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('approval challenge exposes a bounded, verifiable project-change summary', async () => {
  const crypto = require('node:crypto');
  let issuedInput = null;
  const proposals = Array.from({ length: 11 }, (_, index) => ({
    action: index === 0 ? 'update' : index === 1 ? 'create' : 'delete',
    path: index === 0 ? 'x'.repeat(600) : `src/file-${index}.js`,
    content: index === 0 ? 'line one\nline two' : index === 1 ? 'z'.repeat(32001) : '',
    expectedContentSha256: 'a'.repeat(80)
  }));
  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'project.execute_change', steps: [{ step: 1, tool: 'project.execute_change' }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'project.execute_change' }] }
      })
    },
    agentExecutionCoordinator: {
      run: async ({ context }) => {
        throw Object.assign(new Error('approval required'), {
          code: 'APPROVAL_REQUIRED',
          executionContext: {
            executionId: context.executionId,
            step: 1,
            planRevision: 1,
            tool: 'project.execute_change',
            capability: 'workspace.write',
            tenantId: 'tenant-a',
            input: { proposals }
          }
        });
      }
    },
    recoveryCoordinator: { fail: async () => {} },
    persistence: null,
    persistenceCoordinator: {
      persistExecution: async () => ({}),
      checkpoint: async () => ({}),
      persistEvents: async () => []
    },
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({}) },
    approvalService: {
      issue: async args => {
        issuedInput = args;
        return { approvalId: 'approval-summary-test' };
      }
    },
    tenantId: 'tenant-a',
    maxInputChars: 1000
  });

  await assert.rejects(
    coordinator.execute('apply a project change'),
    error => error.code === 'APPROVAL_REQUIRED'
  );

  const summary = issuedInput.metadata.approvalSummary;
  assert.equal(summary.kind, 'file_change');
  assert.equal(summary.changeCount, 11);
  assert.equal(summary.changes.length, 10);
  assert.equal(summary.changes[0].action, 'update');
  assert.equal(summary.changes[0].path.length, 512);
  assert.equal(summary.changes[0].expectedContentSha256.length, 64);
  assert.equal(summary.changes[0].proposedContentSha256, crypto.createHash('sha256').update('line one\nline two', 'utf8').digest('hex'));
  assert.equal(summary.changes[0].contentBytes, Buffer.byteLength('line one\nline two', 'utf8'));
  assert.equal(summary.changes[0].lineCount, 2);
  assert.equal(summary.changes[0].contentTruncated, false);
  assert.equal(summary.changes[1].action, 'create');
  assert.equal(summary.changes[1].proposedContent.length, 32000);
  assert.equal(summary.changes[1].contentTruncated, true);
  assert.equal(summary.changes[2].action, 'invalid');
  assert.match(summary.reviewNotice, /expected current-file SHA-256/);
});
