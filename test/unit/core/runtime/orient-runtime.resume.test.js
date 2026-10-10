const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OrientRuntime =
  require('../../../../src/core/runtime/orient-runtime');

const ExecutionContext =
  require('../../../../src/core/execution/execution-context');

const CheckpointRepository =
  require('../../../../src/infrastructure/persistence/json/checkpoint.repository');

const IdempotencyRepository =
  require('../../../../src/infrastructure/persistence/json/idempotency.repository');

test('runtime resumes from the durable checkpoint without re-running completed steps', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-resume-')
  );

  const checkpoints =
    new CheckpointRepository(
      path.join(directory, 'checkpoints.json')
    );

  const idempotency =
    new IdempotencyRepository(
      path.join(directory, 'idempotency.json')
    );

  const context =
    new ExecutionContext({
      requestId: 'request-1',
      input: 'resume task',
      executionId: 'execution-1'
    });

  context.start();

  const plan = {
    intent: 'resume.test',
    confidence: 1,
    steps: [
      {
        step: 1,
        tool: 'test.first',
        input: 'first',
        dependsOn: null
      },
      {
        step: 2,
        tool: 'test.second',
        input: 'second',
        dependsOn: 1
      }
    ]
  };

  context.transitionAgentTo('planning');
  context.transitionAgentTo('validating');
  context.setPlan(plan);
  context.metadata.planRevision = 1;
  context.metadata.replans = 0;
  context.transitionAgentTo('executing');

  context.startStep({
    step: 1,
    tool: 'test.first',
    planRevision: 1
  });

  context.completeStep({
    step: 1,
    tool: 'test.first',
    result: { value: 'already done' },
    planRevision: 1
  });

  context.addObservation({
    step: 1,
    tool: 'test.first',
    success: true,
    result: { value: 'already done' }
  });

  checkpoints.save(
    context.snapshot(),
    { reason: 'step_completed' }
  );

  const calls = [];

  const toolRegistry = {
    has(tool) {
      return tool === 'test.first' ||
        tool === 'test.second';
    },

    get(tool) {
      return { name: tool };
    },

    async execute(tool) {
      calls.push(tool);

      return {
        value: 'resumed'
      };
    }
  };

  const agentOrchestrator = {
    decideReplanning({ evaluation }) {
      assert.equal(evaluation.outcome, 'done');

      return {
        nextAction: null,
        toJSON() {
          return {
            outcome: 'done',
            nextAction: null,
            reason: 'completed'
          };
        }
      };
    },

    async recover(error) {
      throw error;
    }
  };

  const runtime =
    new OrientRuntime({
      toolRegistry,
      agentOrchestrator,
      persistence: {
        checkpoints,
        idempotency
      }
    });

  const result =
    await runtime.resume(
      'execution-1'
    );

  assert.deepEqual(
    calls,
    ['test.second']
  );

  assert.equal(
    result.execution.status,
    'completed'
  );

  assert.equal(
    result.execution.steps.find(
      step =>
        step.step === 1 &&
        step.planRevision === 1
    ).result.value,
    'already done'
  );

  assert.equal(
    result.execution.steps.find(
      step =>
        step.step === 2 &&
        step.planRevision === 1
    ).result.value,
    'resumed'
  );

  fs.rmSync(directory, {
    recursive: true,
    force: true
  });
});

test('expired approval decision cancels the matching execution and reconciles its workflow', async () => {
  const calls = [];
  const runtime = {
    isCurrentApprovalChallenge: OrientRuntime.prototype.isCurrentApprovalChallenge,
    tenantId: 'tenant-a',
    approvalService: {
      async decide() {
        throw Object.assign(new Error('Approval has expired'), { code: 'APPROVAL_EXPIRED' });
      }
    },
    persistence: {
      executions: {
        async requestCancellation(...args) {
          calls.push({ kind: 'cancel', args });
          return { executionId: args[0], status: 'running' };
        }
      }
    },
    workflowExecutionCoordinator: {
      async expireApprovalWorkflow(...args) {
        calls.push({ kind: 'expire-workflow', args });
        return true;
      }
    }
  };

  await assert.rejects(
    () => OrientRuntime.prototype.decideApproval.call(runtime, {
      approvalId: 'approval-expired',
      executionId: 'execution-expired',
      decision: 'approved',
      actorId: 'owner-session',
      tenantId: 'tenant-a'
    }),
    error => error.code === 'APPROVAL_EXPIRED'
  );

  assert.deepEqual(calls, [
    { kind: 'cancel', args: ['execution-expired', 'approval_expired', { tenantId: 'tenant-a' }] },
    { kind: 'expire-workflow', args: ['execution-expired', 'approval-expired'] }
  ]);
});


test('runtime cancels and reconciles an approval that expires after decision but before resume', async () => {
  const calls = [];
  const expired = Object.assign(new Error('Approved decision expired before execution resume'), {
    code: 'APPROVAL_EXPIRED',
    approvalId: 'approval-race',
    executionId: 'execution-race'
  });
  const runtime = {
    isCurrentApprovalChallenge: OrientRuntime.prototype.isCurrentApprovalChallenge,
    tenantId: 'tenant-a',
    requestExecutionCoordinator: {
      async resume(executionId) {
        assert.equal(executionId, 'execution-race');
        throw expired;
      }
    },
    persistence: {
      executions: {
        async requestCancellation(...args) {
          calls.push({ kind: 'cancel', args });
          return { executionId: args[0], status: 'running' };
        }
      }
    },
    workflowExecutionCoordinator: {
      async expireApprovalWorkflow(...args) {
        calls.push({ kind: 'expire-workflow', args });
        return true;
      }
    }
  };

  await assert.rejects(
    () => OrientRuntime.prototype.resume.call(runtime, 'execution-race', {
      approval: { approvalId: 'approval-race' }
    }),
    error => error.code === 'APPROVAL_EXPIRED'
  );
  assert.deepEqual(calls, [
    { kind: 'cancel', args: ['execution-race', 'approval_expired', { tenantId: 'tenant-a' }] },
    { kind: 'expire-workflow', args: ['execution-race', 'approval-race'] }
  ]);
});


test('expired stale approval does not cancel a workflow waiting on a newer challenge', async () => {
  const calls = [];
  const expired = Object.assign(new Error('Approval has expired'), {
    code: 'APPROVAL_EXPIRED',
    approvalId: 'approval-old',
    executionId: 'execution-stale'
  });
  const runtime = {
    isCurrentApprovalChallenge: OrientRuntime.prototype.isCurrentApprovalChallenge,
    tenantId: 'tenant-a',
    approvalService: { async decide() { throw expired; } },
    requestExecutionCoordinator: { async resume() { throw expired; } },
    persistence: {
      executions: {
        async requestCancellation(...args) { calls.push({ kind: 'cancel', args }); return { executionId: args[0] }; }
      }
    },
    workflowExecutionCoordinator: {
      async findApprovalBlockedWorkflow() {
        return { metadata: { approvalId: 'approval-new' } };
      },
      async expireApprovalWorkflow(...args) { calls.push({ kind: 'expire', args }); }
    }
  };

  await assert.rejects(
    () => OrientRuntime.prototype.decideApproval.call(runtime, {
      approvalId: 'approval-old', executionId: 'execution-stale',
      decision: 'approved', actorId: 'owner', tenantId: 'tenant-a'
    }),
    error => error.code === 'APPROVAL_EXPIRED'
  );
  await assert.rejects(
    () => OrientRuntime.prototype.resume.call(runtime, 'execution-stale', {
      approval: { approvalId: 'approval-old' }
    }),
    error => error.code === 'APPROVAL_EXPIRED'
  );
  assert.deepEqual(calls, [], 'stale approval expiry must not cancel the newer active challenge');
});


test('real runtime restart reconciles a durable terminal execution without replaying tools', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-terminal-restart-'));
  try {
    const JsonPersistence = require('../../../../src/infrastructure/persistence/json/json-persistence');
    const persistence = new JsonPersistence({ rootDir: directory });
    const context = new ExecutionContext({
      requestId: 'request-terminal-restart',
      input: 'do not replay completed work',
      executionId: 'execution-terminal-restart',
      tenantId: 'local',
      userId: 'local',
      workspaceId: 'local'
    });
    context.start();
    const plan = {
      intent: 'restart.recovery',
      confidence: 1,
      steps: [{ step: 1, tool: 'test.side-effect', input: 'charge once', dependsOn: null }]
    };
    context.transitionAgentTo('planning');
    context.transitionAgentTo('validating');
    context.setPlan(plan);
    context.metadata.planRevision = 1;
    context.metadata.replans = 0;
    context.transitionAgentTo('executing');
    context.startStep({ step: 1, tool: 'test.side-effect', planRevision: 1 });
    context.completeStep({
      step: 1,
      tool: 'test.side-effect',
      result: { receipt: 'already-committed' },
      planRevision: 1
    });
    context.addObservation({
      step: 1,
      tool: 'test.side-effect',
      success: true,
      result: { receipt: 'already-committed' }
    });

    await persistence.executions.insert({
      ...context.snapshot(),
      status: 'completed',
      result: { receipt: 'already-committed' },
      completedAt: new Date().toISOString()
    }, { tenantId: 'local' });
    await persistence.checkpoints.save(context.snapshot(), {
      reason: 'crash-window-stale-checkpoint',
      tenantId: 'local'
    });

    // A newly constructed runtime represents a process restart. The persisted
    // terminal execution must override the older active checkpoint.
    let toolCalls = 0;
    const runtimeAfterRestart = new OrientRuntime({
      toolRegistry: {
        has: tool => tool === 'test.side-effect',
        get: tool => ({ name: tool }),
        async execute() {
          toolCalls += 1;
          return { receipt: 'duplicate' };
        }
      },
      agentOrchestrator: {
        decideReplanning() {
          return { nextAction: null, toJSON: () => ({ outcome: 'done', nextAction: null }) };
        },
        async recover(error) { throw error; }
      },
      persistence
    });

    const result = await runtimeAfterRestart.resume('execution-terminal-restart');

    assert.equal(result.resumed, false);
    assert.equal(result.reason, 'execution_already_terminal');
    assert.equal(result.reconciled, true);
    assert.equal(result.execution.status, 'completed');
    assert.deepEqual(result.execution.result, { receipt: 'already-committed' });
    assert.equal(toolCalls, 0, 'terminal recovery must not replay the external side effect');

    const repairedCheckpoint = await persistence.checkpoints.findLatest('execution-terminal-restart', {
      tenantId: 'local'
    });
    assert.equal(repairedCheckpoint.snapshot.status, 'completed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('real runtime restart reconciles an approval-blocked workflow from a durable terminal execution', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-workflow-restart-'));
  try {
    const JsonPersistence = require('../../../../src/infrastructure/persistence/json/json-persistence');
    const persistence = new JsonPersistence({ rootDir: directory });
    const executionId = 'execution-approval-restart';
    const workflowId = 'workflow-approval-restart';

    const context = new ExecutionContext({
      requestId: 'request-approval-restart',
      input: 'resume the already committed approved operation',
      executionId,
      tenantId: 'tenant-restart',
      userId: 'owner-session',
      workspaceId: 'workspace-restart'
    });
    context.start();
    const plan = {
      intent: 'approval.restart.reconciliation',
      confidence: 1,
      steps: [{ step: 1, tool: 'test.approved-side-effect', input: { operationId: 'operation-1' }, dependsOn: null }]
    };
    context.transitionAgentTo('planning');
    context.transitionAgentTo('validating');
    context.setPlan(plan);
    context.metadata.planRevision = 1;
    context.metadata.replans = 0;
    context.metadata.pendingStepInputs = { 1: { operationId: 'operation-1' } };
    context.transitionAgentTo('executing');

    const completedSnapshot = {
      ...context.snapshot(),
      status: 'completed',
      result: { receipt: 'durably-committed' },
      completedAt: new Date().toISOString()
    };
    await persistence.executions.insert(completedSnapshot, { tenantId: 'tenant-restart' });
    await persistence.checkpoints.save(context.snapshot(), {
      reason: 'stale-approval-checkpoint-before-terminal-commit',
      tenantId: 'tenant-restart'
    });

    let toolCalls = 0;
    const runtimeAfterRestart = new OrientRuntime({
      tenantId: 'tenant-restart',
      userId: 'owner-session',
      workspaceId: 'workspace-restart',
      toolRegistry: {
        has: tool => tool === 'test.approved-side-effect',
        get: tool => ({ name: tool }),
        async execute() {
          toolCalls += 1;
          return { receipt: 'duplicate-side-effect' };
        }
      },
      agentOrchestrator: {
        decideReplanning() {
          return { nextAction: null, toJSON: () => ({ outcome: 'done', nextAction: null }) };
        },
        async recover(error) { throw error; }
      },
      persistence
    });

    const created = runtimeAfterRestart.workflowExecutionCoordinator.createInstance(
      'resume the approved operation',
      { workflowId }
    );
    assert.ok(created.instance);
    const workflow = created.instance;
    workflow.transition('QUEUED');
    workflow.transition('RUNNING');
    workflow.transition('WAITING');
    workflow.metadata = {
      ...workflow.metadata,
      taskId: workflowId,
      approvalBlocked: true,
      approvalExecutionId: executionId,
      approvalId: 'approval-durable-restart'
    };
    await persistence.workflows.save(workflow, 'tenant-restart');

    const result = await runtimeAfterRestart.resume(executionId);

    assert.equal(result.resumed, false);
    assert.equal(result.reason, 'execution_already_terminal');
    assert.equal(result.execution.status, 'completed');
    assert.equal(result.execution.result.receipt, 'durably-committed');
    assert.equal(toolCalls, 0, 'the real Runtime resume path must not replay the committed tool');

    const reconciled = await persistence.workflows.findById(workflowId, 'tenant-restart');
    assert.equal(reconciled.state, 'COMPLETED');
    assert.equal(reconciled.metadata.approvalBlocked, false);
    assert.equal(reconciled.metadata.approvalDecisionStatus, 'approved');
    assert.equal(reconciled.steps['agent-runtime'].state, 'COMPLETED');

    const repairedCheckpoint = await persistence.checkpoints.findLatest(executionId, {
      tenantId: 'tenant-restart'
    });
    assert.equal(repairedCheckpoint.snapshot.status, 'completed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('durable approval decision survives ApprovalService reconstruction and remains scope-bound', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approved-decision-restart-'));
  try {
    const JsonPersistence = require('../../../../src/infrastructure/persistence/json/json-persistence');
    const ApprovalService = require('../../../../src/core/agent/approval/approval-service');
    const persistence = new JsonPersistence({ rootDir: directory });
    const tenantId = 'tenant-approval-restart';
    const executionId = 'execution-approval-decision-restart';
    const ownerActorId = 'owner-session-restart';

    const approvalServiceBeforeRestart = new ApprovalService({
      repository: persistence.approvals,
      tenantId,
      decisionAuthorizer: async ({ actorId }) => actorId === ownerActorId
    });
    const issued = await approvalServiceBeforeRestart.issue({
      executionId,
      step: 2,
      planRevision: 3,
      tool: 'danger.write',
      capability: 'external.write',
      scope: { resourceId: 'resource-42' },
      tenantId,
      ttlMs: 60000
    });

    const decision = await approvalServiceBeforeRestart.decide({
      approvalId: issued.approvalId,
      executionId,
      decision: 'approved',
      actorId: ownerActorId,
      tenantId
    });
    assert.equal(decision.decision.status, 'approved');

    // Reconstruct the service against the same durable repository as after a process restart.
    const approvalServiceAfterRestart = new ApprovalService({
      repository: persistence.approvals,
      tenantId,
      decisionAuthorizer: async ({ actorId }) => actorId === ownerActorId
    });
    const restored = await approvalServiceAfterRestart.getApprovedForExecution({
      approvalId: issued.approvalId,
      executionId,
      tenantId
    });
    assert.equal(restored.decision.status, 'approved');
    assert.equal(restored.decision.actorId, ownerActorId);

    const valid = await approvalServiceAfterRestart.validate({
      approval: { approvalId: issued.approvalId },
      executionId,
      step: 2,
      planRevision: 3,
      tool: 'danger.write',
      capability: 'external.write',
      scope: { resourceId: 'resource-42' },
      tenantId
    });
    assert.equal(valid.allowed, true);

    const wrongScope = await approvalServiceAfterRestart.validate({
      approval: { approvalId: issued.approvalId },
      executionId,
      step: 2,
      planRevision: 3,
      tool: 'danger.write',
      capability: 'external.write',
      scope: { resourceId: 'resource-other' },
      tenantId
    });
    assert.equal(wrongScope.allowed, false);
    assert.equal(wrongScope.reason, 'APPROVAL_SCOPE_MISMATCH');

    assert.equal(await approvalServiceAfterRestart.consume(issued.approvalId, tenantId), true);
    assert.equal(await approvalServiceAfterRestart.getApprovedForExecution({
      approvalId: issued.approvalId,
      executionId,
      tenantId
    }), null, 'consumed approvals must not be reusable after restart');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
