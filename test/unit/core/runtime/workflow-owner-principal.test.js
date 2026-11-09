'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WorkflowExecutionCoordinator = require('../../../../src/core/runtime/workflow-execution-coordinator');
const { WorkflowDefinition, WorkflowInstance } = require('../../../../src/core/workflow');

function fixture() {
  const principal = { tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' };
  const calls = [];
  const definition = new WorkflowDefinition({
    id: 'owner-approval-test', version: 1, name: 'Owner approval test',
    steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME' }]
  });
  const instance = new WorkflowInstance({
    definition, workflowId: 'workflow-owner-approval', tenantId: 'tenant-a',
    userId: 'owner-a', workspaceId: 'workspace-a', input: { text: 'guarded operation' }
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  instance.transition('WAITING');
  instance.metadata = {
    ...instance.metadata,
    approvalBlocked: true,
    approvalExecutionId: 'execution-owner-approval',
    approvalId: 'approval-old'
  };
  const workflowRepository = {
    async findByApprovalExecutionId(options) {
      calls.push({ kind: 'find', options });
      return instance.toJSON();
    },
    async findAll() { return [instance.toJSON()]; },
    async save() { throw new Error('Owner approval snapshot must use the durable event sink'); }
  };
  const missionEventSink = {
    async recordSnapshot(value, reason, options) {
      calls.push({ kind: 'snapshot', workflowId: value.workflowId, reason, persistencePrincipal: options.persistencePrincipal });
    }
  };
  const coordinator = new WorkflowExecutionCoordinator({
    scheduler: {}, workflowRepository, missionEventSink,
    tenantId: 'tenant-a', userId: 'owner-a', workspaceId: 'workspace-a',
    executeRequest: async () => ({})
  });
  return { coordinator, instance, principal, calls };
}

test('approval challenge refresh carries owner authority into workflow lookup and durable snapshot event', async () => {
  const h = fixture();
  await h.coordinator.updateApprovalChallenge('execution-owner-approval', 'approval-new', h.principal);
  assert.strictEqual(h.calls.find(call => call.kind === 'find').options.persistencePrincipal, h.principal);
  const snapshot = h.calls.find(call => call.kind === 'snapshot');
  assert.equal(snapshot.reason, 'approval_resolution');
  assert.strictEqual(snapshot.persistencePrincipal, h.principal);
});

test('approval resume reconciliation carries owner authority into lookup and snapshot persistence', async () => {
  const h = fixture();
  await h.coordinator.reconcileApprovalResume('execution-owner-approval', {
    result: { ok: true },
    execution: { executionId: 'execution-owner-approval', status: 'completed' }
  }, h.principal);
  assert.strictEqual(h.calls.find(call => call.kind === 'find').options.persistencePrincipal, h.principal);
  assert.strictEqual(h.calls.find(call => call.kind === 'snapshot').persistencePrincipal, h.principal);
});

test('approval expiry and cancellation both use the same owner authority', async () => {
  for (const action of ['expire', 'cancel']) {
    const h = fixture();
    if (action === 'expire') {
      await h.coordinator.expireApprovalWorkflow('execution-owner-approval', 'approval-old', h.principal);
    } else {
      await h.coordinator.cancelApprovalWorkflow('execution-owner-approval', 'owner_rejected', h.principal);
    }
    assert.strictEqual(h.calls.find(call => call.kind === 'find').options.persistencePrincipal, h.principal);
    assert.strictEqual(h.calls.find(call => call.kind === 'snapshot').persistencePrincipal, h.principal);
  }
});
