'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RequestExecutionCoordinator = require('../../../../src/core/runtime/request-execution-coordinator');
const AgentState = require('../../../../src/core/agent/state/agent-state');

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
