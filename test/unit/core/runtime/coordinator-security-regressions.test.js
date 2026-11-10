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
