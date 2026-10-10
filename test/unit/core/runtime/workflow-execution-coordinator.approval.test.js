'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');
const WorkflowRepository = require('../../../../src/infrastructure/persistence/json/workflow.repository');
const WorkflowExecutionCoordinator = require('../../../../src/core/runtime/workflow-execution-coordinator');

function createCoordinator(root) {
  const repository = new WorkflowRepository(path.join(root, 'workflows.json'));
  const coordinator = new WorkflowExecutionCoordinator({
    scheduler: {},
    workflowRepository: repository,
    tenantId: 'tenant-a',
    executeRequest: async () => ({ ok: true })
  });
  return { repository, coordinator };
}

async function saveApprovalBlockedWorkflow(repository, { workflowId, executionId, approvalId }) {
  const definition = new WorkflowDefinition({
    id: 'orient.request.execution',
    version: 1,
    name: 'ORIENT Request Execution',
    steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME' }]
  });
  const instance = new WorkflowInstance({
    definition,
    workflowId,
    tenantId: 'tenant-a',
    input: { text: 'perform a guarded operation' }
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  instance.transition('WAITING');
  instance.metadata = {
    approvalBlocked: true,
    approvalExecutionId: executionId,
    approvalId,
    approvalRequiredAt: new Date().toISOString()
  };
  await repository.save(instance, 'tenant-a');
  return instance;
}

test('approved execution reconciles its blocked workflow to a durable completed state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflow-approval-resume-'));
  try {
    const { repository, coordinator } = createCoordinator(root);
    await saveApprovalBlockedWorkflow(repository, {
      workflowId: 'workflow-approval-complete',
      executionId: 'execution-approval-complete',
      approvalId: 'approval-complete'
    });

    const reconciled = await coordinator.reconcileApprovalResume('execution-approval-complete', {
      resumed: true,
      result: { status: 'verified' },
      execution: { executionId: 'execution-approval-complete', status: 'completed' }
    });

    assert.equal(reconciled.workflowId, 'workflow-approval-complete');
    assert.equal(reconciled.state, WorkflowInstance.STATES.COMPLETED);
    assert.equal(reconciled.steps['agent-runtime'].state, WorkflowDefinition.STEP_STATES.COMPLETED);
    assert.equal(reconciled.steps['agent-runtime'].result.executionId, 'execution-approval-complete');
    assert.equal(reconciled.metadata.approvalBlocked, false);
    assert.equal(reconciled.metadata.approvalDecisionStatus, 'approved');

    const persisted = await repository.findById('workflow-approval-complete', 'tenant-a');
    assert.equal(persisted.state, WorkflowInstance.STATES.COMPLETED);
    assert.equal(persisted.metadata.approvalBlocked, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('approval challenge refresh and rejection update the same tenant-scoped workflow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflow-approval-reject-'));
  try {
    const { repository, coordinator } = createCoordinator(root);
    await saveApprovalBlockedWorkflow(repository, {
      workflowId: 'workflow-approval-reject',
      executionId: 'execution-approval-reject',
      approvalId: 'approval-old'
    });

    assert.equal(await coordinator.updateApprovalChallenge('execution-approval-reject', 'approval-new'), true);
    const refreshed = await repository.findById('workflow-approval-reject', 'tenant-a');
    assert.equal(refreshed.metadata.approvalId, 'approval-new');
    assert.equal(refreshed.metadata.approvalBlocked, true);

    const cancelled = await coordinator.cancelApprovalWorkflow('execution-approval-reject', 'owner_rejected');
    assert.equal(cancelled.state, WorkflowInstance.STATES.CANCELLED);
    assert.equal(cancelled.metadata.approvalBlocked, false);
    assert.equal(cancelled.metadata.approvalDecisionStatus, 'rejected');
    assert.equal(cancelled.metadata.cancellationReason, 'owner_rejected');

    assert.equal(await coordinator.updateApprovalChallenge('execution-approval-reject', 'approval-late'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
