'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RequestExecutionCoordinator = require('../../../../src/core/runtime/request-execution-coordinator');
const AgentState = require('../../../../src/core/agent/state/agent-state');
const CheckpointRepository = require('../../../../src/infrastructure/persistence/json/checkpoint.repository');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

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


test('resume rejects a checkpoint owned by another persistence principal before durable lookup or side effects', async () => {
  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const context = new ExecutionContext({
    requestId: 'request-owner-mismatch',
    input: 'must not resume another owner checkpoint',
    executionId: 'execution-owner-mismatch',
    tenantId: 'tenant-a',
    userId: 'owner-b',
    workspaceId: 'workspace-b'
  });
  context.start();
  context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
  context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
  context.setPlan({
    intent: 'test.owner-mismatch',
    steps: [{ step: 1, tool: 'test.side-effect', input: {}, dependsOn: null }]
  });
  context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);

  const principal = Object.freeze({
    kind: 'owner', tenantId: 'tenant-a', ownerId: 'owner-a',
    sessionId: 'session-owner-a', issuedAt: Date.now()
  });
  let durableLookups = 0;
  let leaseAcquisitions = 0;
  let toolRuns = 0;
  let checkpointReads = 0;

  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: { run: async () => { toolRuns += 1; } },
    recoveryCoordinator: {},
    persistence: {
      checkpoints: {
        findLatest: async () => {
          checkpointReads += 1;
          return { checkpointId: 'checkpoint-owner-mismatch', sequence: 1, snapshot: context.snapshot() };
        },
        acquireResumeLease: async () => { leaseAcquisitions += 1; return { leaseId: 'must-not-acquire' }; }
      },
      executions: { findById: async () => { durableLookups += 1; return null; } }
    },
    persistenceCoordinator: {},
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    userId: 'owner-a',
    workspaceId: 'workspace-a',
    maxInputChars: 1000
  });

  await assert.rejects(
    coordinator.resume('execution-owner-mismatch', { persistencePrincipal: principal }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_MISMATCH'
  );

  assert.equal(checkpointReads, 1, 'the scoped checkpoint may be retrieved before validating its owner');
  assert.equal(durableLookups, 0, 'owner mismatch must be rejected before durable execution lookup');
  assert.equal(leaseAcquisitions, 0, 'owner mismatch must not acquire a resume lease');
  assert.equal(toolRuns, 0, 'owner mismatch must never enter tool execution');
});


test('resume rejects a checkpoint from another tenant before durable lookup or side effects', async () => {
  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const context = new ExecutionContext({
    requestId: 'request-tenant-mismatch',
    input: 'must not resume another tenant checkpoint',
    executionId: 'execution-tenant-mismatch',
    tenantId: 'tenant-b',
    userId: 'owner-a',
    workspaceId: 'workspace-b'
  });
  context.start();
  context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
  context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
  context.setPlan({
    intent: 'test.tenant-mismatch',
    steps: [{ step: 1, tool: 'test.side-effect', input: {}, dependsOn: null }]
  });
  context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);

  let durableLookups = 0;
  let leaseAcquisitions = 0;
  let toolRuns = 0;
  let tenantAssertions = 0;

  const coordinator = new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: { run: async () => { toolRuns += 1; } },
    recoveryCoordinator: {},
    persistence: {
      checkpoints: {
        findLatest: async () => ({
          checkpointId: 'checkpoint-tenant-mismatch',
          sequence: 1,
          snapshot: context.snapshot()
        }),
        acquireResumeLease: async () => { leaseAcquisitions += 1; return { leaseId: 'must-not-acquire' }; }
      },
      executions: { findById: async () => { durableLookups += 1; return null; } }
    },
    persistenceCoordinator: {},
    quotaService: {
      assertTenant: () => { tenantAssertions += 1; },
      assertInputSize: () => {}
    },
    quotaPolicy: { toJSON: () => ({}) },
    tenantId: 'tenant-a',
    userId: 'owner-a',
    workspaceId: 'workspace-a',
    maxInputChars: 1000
  });

  await assert.rejects(
    coordinator.resume('execution-tenant-mismatch'),
    error => error.code === 'TENANT_CONTEXT_MISMATCH'
  );

  assert.equal(tenantAssertions, 1, 'the tenant quota policy is checked before the context mismatch is rejected');
  assert.equal(durableLookups, 0, 'tenant mismatch must be rejected before durable execution lookup');
  assert.equal(leaseAcquisitions, 0, 'tenant mismatch must not acquire a resume lease');
  assert.equal(toolRuns, 0, 'tenant mismatch must never enter tool execution');
});


function coordinatorFixture(overrides = {}) {
  return new RequestExecutionCoordinator({
    agentOrchestrator: {},
    agentExecutionCoordinator: {},
    recoveryCoordinator: { fail: async () => {} },
    persistence: null,
    persistenceCoordinator: {
      persistExecution: async () => {},
      persistEvents: async () => [],
      checkpoint: async () => ({})
    },
    quotaService: { assertTenant: () => {}, assertInputSize: () => {} },
    quotaPolicy: { toJSON: () => ({ plan: 'test' }) },
    tenantId: 'tenant-a',
    userId: 'owner-a',
    workspaceId: 'workspace-a',
    maxInputChars: 1000,
    ...overrides
  });
}

test('coordinator constructor validates required dependencies and applies local identity defaults', () => {
  const required = {
    agentOrchestrator: {},
    agentExecutionCoordinator: {},
    recoveryCoordinator: {},
    quotaService: {}
  };
  for (const key of Object.keys(required)) {
    const dependencies = { ...required };
    delete dependencies[key];
    assert.throws(
      () => new RequestExecutionCoordinator(dependencies),
      error => error instanceof TypeError && error.message === key + ' is required'
    );
  }

  const coordinator = new RequestExecutionCoordinator({
    ...required,
    persistence: null,
    persistenceCoordinator: {},
    quotaPolicy: {}
  });
  assert.equal(coordinator.tenantId, 'local');
  assert.equal(coordinator.userId, 'local');
  assert.equal(coordinator.workspaceId, 'local');
  assert.equal(coordinator.resumeLeaseDurationMs, 30000);
});

test('plan fingerprint includes all execution-relevant identity and step fields', () => {
  const coordinator = coordinatorFixture();
  const base = {
    intent: 'project.change',
    agentId: 'agent-a',
    input: { path: 'src/a.js' },
    steps: [{ step: 1, tool: 'project.execute_change', input: { content: 'one' }, dependsOn: [0] }]
  };
  const fingerprint = coordinator.planFingerprint(base);
  assert.equal(typeof fingerprint, 'string');
  assert.notEqual(coordinator.planFingerprint(null), fingerprint);
  assert.notEqual(coordinator.planFingerprint({ ...base, intent: 'project.read' }), fingerprint);
  assert.notEqual(coordinator.planFingerprint({ ...base, agentId: 'agent-b' }), fingerprint);
  assert.notEqual(coordinator.planFingerprint({ ...base, input: { path: 'src/b.js' } }), fingerprint);
  assert.notEqual(coordinator.planFingerprint({
    ...base,
    steps: [{ ...base.steps[0], tool: 'shell.exec' }]
  }), fingerprint);
  assert.notEqual(coordinator.planFingerprint({
    ...base,
    steps: [{ ...base.steps[0], input: { content: 'two' } }]
  }), fingerprint);
  assert.notEqual(coordinator.planFingerprint({
    ...base,
    steps: [{ ...base.steps[0], dependsOn: [1] }]
  }), fingerprint);

  assert.deepEqual(
    coordinator.validateReplannedPlan(null, fingerprint),
    { valid: false, reason: 'لم يتم إنشاء خطة جديدة' }
  );
  assert.equal(coordinator.validateReplannedPlan(base, fingerprint).valid, false);
  const changed = { ...base, intent: 'project.read' };
  const validated = coordinator.validateReplannedPlan(changed, fingerprint);
  assert.equal(validated.valid, true);
  assert.equal(validated.fingerprint, coordinator.planFingerprint(changed));
});

test('owner session authorization requires an exact positive authorizer result', async () => {
  assert.equal(await coordinatorFixture().assertOwnerSessionContext(null), true);
  await assert.rejects(
    coordinatorFixture().assertOwnerSessionContext({ sessionId: 'session-a' }),
    error => error.code === 'OWNER_SESSION_REJECTED' && error.statusCode === 401
  );
  await assert.rejects(
    coordinatorFixture({ ownerSessionAuthorizer: async () => 1 })
      .assertOwnerSessionContext({ sessionId: 'session-a' }),
    error => error.code === 'OWNER_SESSION_REJECTED'
  );
  assert.equal(
    await coordinatorFixture({ ownerSessionAuthorizer: async id => id === 'session-a' })
      .assertOwnerSessionContext({ sessionId: 'session-a' }),
    true
  );
});

test('cancellation lookup is tenant and principal scoped and fails closed only on durable cancellation', async () => {
  const principal = Object.freeze({ tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' });
  let args = null;
  const coordinator = coordinatorFixture({
    persistence: {
      executions: {
        findById: async (id, options) => {
          args = { id, options };
          return { cancellationRequested: true };
        }
      }
    }
  });
  assert.equal(await coordinator.isCancellationRequested(null, principal), false);
  assert.equal(await coordinator.isCancellationRequested('execution-a', principal), true);
  assert.deepEqual(args, {
    id: 'execution-a',
    options: { tenantId: 'tenant-a', persistencePrincipal: principal }
  });
  assert.equal(await coordinatorFixture().isCancellationRequested('execution-a'), false);
  assert.equal(await coordinatorFixture({
    persistence: { executions: { findById: async () => ({ cancellationRequested: false }) } }
  }).isCancellationRequested('execution-a'), false);
});

test('active snapshots isolate event objects and terminal contexts are not snapshotted', () => {
  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const coordinator = coordinatorFixture();
  const context = new ExecutionContext({
    requestId: 'request-snapshot-isolation',
    input: 'snapshot events',
    tenantId: 'tenant-a'
  });
  context.start();
  context.record('test.snapshot', { marker: 'before' });
  const snapshot = coordinator.snapshotActiveContext(context);
  const lastIndex = context.events.length - 1;
  context.events[lastIndex].data.marker = 'after';
  assert.equal(snapshot.events[lastIndex].data.marker, 'before');
  context.cancel('finished');
  assert.equal(coordinator.snapshotActiveContext(context), null);
});

test('resume heartbeat coalesces concurrent renewals and makes renewal failure sticky', async () => {
  const coordinator = coordinatorFixture();
  let resolveRenewal;
  let renewalCalls = 0;
  const heartbeat = coordinator.createResumeLeaseHeartbeat(() => {
    renewalCalls += 1;
    return new Promise(resolve => { resolveRenewal = resolve; });
  }, 1000);
  const first = heartbeat.renew();
  const second = heartbeat.renew();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(renewalCalls, 1);
  resolveRenewal();
  await first;
  await heartbeat.stop();

  const expected = new Error('lease renewal failed');
  const failedHeartbeat = coordinator.createResumeLeaseHeartbeat(async () => { throw expected; }, 1000);
  await assert.rejects(failedHeartbeat.renew(), error => error === expected);
  await assert.rejects(failedHeartbeat.renew(), error => error === expected);
  await assert.rejects(failedHeartbeat.stop(), error => error === expected);
  assert.throws(
    () => coordinator.createResumeLeaseHeartbeat(null, 1000),
    /renewLease is required/
  );
  assert.throws(
    () => coordinator.createResumeLeaseHeartbeat(async () => {}, 0),
    /intervalMs must be a positive integer/
  );
});

test('empty and oversized requests are rejected before quota, persistence, or orchestration', async () => {
  let quotaCalls = 0;
  let persistenceCalls = 0;
  let planningCalls = 0;
  const coordinator = coordinatorFixture({
    maxInputChars: 3,
    quotaService: {
      assertTenant: () => { quotaCalls += 1; },
      assertInputSize: () => { quotaCalls += 1; }
    },
    persistenceCoordinator: {
      persistExecution: async () => { persistenceCalls += 1; }
    },
    agentOrchestrator: { plan: async () => { planningCalls += 1; } }
  });
  const empty = await coordinator.execute('   ');
  assert.equal(empty.type, 'error');
  const oversized = await coordinator.execute('four');
  assert.equal(oversized.code, 'INPUT_TOO_LARGE');
  assert.equal(quotaCalls, 0);
  assert.equal(persistenceCalls, 0);
  assert.equal(planningCalls, 0);
});

test('successful execution classifies memory responses and returns bounded result metadata', async () => {
  let persistedEvents = 0;
  let receivedPrincipal = null;
  const principal = Object.freeze({ tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' });
  const coordinator = coordinatorFixture({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'memory.search', input: 'find these', steps: [{ step: 1, tool: 'memory.search' }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'memory.search' }] }
      })
    },
    agentExecutionCoordinator: {
      run: async args => {
        receivedPrincipal = args.persistencePrincipal;
        args.context.transitionAgentTo(AgentState.LIFECYCLE.VALIDATING);
        args.context.transitionAgentTo(AgentState.LIFECYCLE.EXECUTING);
        args.context.transitionAgentTo(AgentState.LIFECYCLE.OBSERVING);
        args.context.transitionAgentTo(AgentState.LIFECYCLE.EVALUATING);
        return {
          plan: args.plan,
          loopResult: { result: { memories: [{ id: 1 }, { id: 2 }] }, evaluation: { success: true } },
          replanningDecision: { toJSON: () => ({ outcome: 'complete' }) }
        };
      }
    },
    persistenceCoordinator: {
      persistExecution: async () => undefined,
      persistEvents: async () => { persistedEvents += 1; }
    }
  });
  const result = await coordinator.execute('search memory', { persistencePrincipal: principal });
  assert.equal(result.type, 'memory_result');
  assert.equal(result.query, 'find these');
  assert.equal(result.count, 2);
  assert.deepEqual(result.evaluation, { success: true });
  assert.deepEqual(result.replanning, { outcome: 'complete' });
  assert.equal(result.execution.status, 'completed');
  assert.strictEqual(receivedPrincipal, principal);
  assert.equal(persistedEvents, 1);
});

test('generic execution failures invoke recovery with the owner principal and preserve the original error', async () => {
  const principal = Object.freeze({ tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' });
  const failure = Object.assign(new Error('tool failed'), { code: 'TOOL_FAILED' });
  let recoveryArgs = null;
  const coordinator = coordinatorFixture({
    agentOrchestrator: {
      plan: async () => ({
        plan: { intent: 'test.failure', steps: [{ step: 1, tool: 'test.tool' }] },
        validation: { valid: true, steps: [{ step: 1, tool: 'test.tool' }] }
      })
    },
    agentExecutionCoordinator: { run: async () => { throw failure; } },
    recoveryCoordinator: { fail: async args => { recoveryArgs = args; } }
  });
  await assert.rejects(
    coordinator.execute('run failing task', { persistencePrincipal: principal }),
    error => error === failure
  );
  assert.equal(recoveryArgs.error, failure);
  assert.strictEqual(recoveryArgs.persistencePrincipal, principal);
});

test('resume rejects absent checkpoint storage, missing checkpoints, and malformed checkpoint plans before lease acquisition', async () => {
  const coordinator = coordinatorFixture();
  await assert.rejects(
    coordinator.resume('execution-a'),
    error => error.code === 'CHECKPOINT_STORAGE_REQUIRED'
  );

  const missing = coordinatorFixture({
    persistence: { checkpoints: { findLatest: async () => null } }
  });
  await assert.rejects(
    missing.resume('execution-missing'),
    error => error.code === 'CHECKPOINT_NOT_FOUND'
  );

  const ExecutionContext = require('../../../../src/core/execution/execution-context');
  const invalidPlanContext = new ExecutionContext({
    requestId: 'request-invalid-plan',
    input: 'invalid checkpoint',
    executionId: 'execution-invalid-plan',
    tenantId: 'tenant-a'
  });
  invalidPlanContext.start();
  const invalidPlan = coordinatorFixture({
    persistence: {
      checkpoints: { findLatest: async () => ({ checkpointId: 'checkpoint-invalid-plan', sequence: 1, snapshot: invalidPlanContext.snapshot() }) }
    }
  });
  await assert.rejects(
    invalidPlan.resume('execution-invalid-plan'),
    error => error.code === 'CHECKPOINT_PLAN_REQUIRED'
  );

  const invalidRevisionContext = new ExecutionContext({
    requestId: 'request-invalid-revision',
    input: 'invalid revision',
    executionId: 'execution-invalid-revision',
    tenantId: 'tenant-a'
  });
  invalidRevisionContext.start();
  invalidRevisionContext.setPlan({ intent: 'test.invalid-revision', steps: [{ step: 1, tool: 'test.tool' }] });
  invalidRevisionContext.metadata.planRevision = 'not-a-number';
  const invalidRevision = coordinatorFixture({
    persistence: {
      checkpoints: { findLatest: async () => ({ checkpointId: 'checkpoint-invalid-revision', sequence: 1, snapshot: invalidRevisionContext.snapshot() }) }
    }
  });
  await assert.rejects(
    invalidRevision.resume('execution-invalid-revision'),
    error => error.code === 'CHECKPOINT_PLAN_REVISION_INVALID'
  );
});
