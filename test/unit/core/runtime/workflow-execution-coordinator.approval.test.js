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
const WorkflowScheduler = require('../../../../src/core/workflow/workflow-scheduler');

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
    taskId: workflowId,
    executionId,
    approvalBlocked: true,
    approvalExecutionId: executionId,
    approvalId,
    approvalRequiredAt: new Date().toISOString()
  };
  await repository.save(instance, 'tenant-a');
  return instance;
}

test('new durable workflows persist a stable taskId alias before any worker starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflow-task-identity-'));
  try {
    const { repository, coordinator } = createCoordinator(root);
    const created = coordinator.createInstance('persist task identity', {
      workflowId: 'task-identity-1'
    });
    assert.equal(created.instance.metadata.taskId, 'task-identity-1');
    assert.equal(created.instance.workflowId, 'task-identity-1');
    await repository.save(created.instance, 'tenant-a');
    const persisted = await repository.findById('task-identity-1', 'tenant-a');
    assert.equal(persisted.metadata.taskId, persisted.workflowId);
    assert.equal(persisted.metadata.executionId, undefined);
    assert.equal(persisted.metadata.approvalId, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.equal(reconciled.metadata.taskId, 'workflow-approval-complete');
    assert.equal(reconciled.metadata.executionId, 'execution-approval-complete');
    assert.equal(reconciled.metadata.approvalBlocked, false);
    assert.equal(reconciled.metadata.approvalDecisionStatus, 'approved');

    const persisted = await repository.findById('workflow-approval-complete', 'tenant-a');
    assert.equal(persisted.state, WorkflowInstance.STATES.COMPLETED);
    assert.equal(persisted.metadata.approvalBlocked, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expired approval terminalizes only the workflow carrying that exact challenge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflow-approval-expire-'));
  try {
    const { repository, coordinator } = createCoordinator(root);
    await saveApprovalBlockedWorkflow(repository, {
      workflowId: 'workflow-approval-expire',
      executionId: 'execution-approval-expire',
      approvalId: 'approval-expired'
    });

    assert.equal(await coordinator.expireApprovalWorkflow('execution-approval-expire', 'wrong-approval'), false);
    assert.equal((await repository.findById('workflow-approval-expire', 'tenant-a')).metadata.approvalBlocked, true);

    const expired = await coordinator.expireApprovalWorkflow('execution-approval-expire', 'approval-expired');
    assert.equal(expired.state, WorkflowInstance.STATES.CANCELLED);
    assert.equal(expired.metadata.approvalBlocked, false);
    assert.equal(expired.metadata.approvalDecisionStatus, 'expired');
    assert.equal(expired.metadata.cancellationReason, 'approval_expired');

    const persisted = await repository.findById('workflow-approval-expire', 'tenant-a');
    assert.equal(persisted.state, WorkflowInstance.STATES.CANCELLED);
    assert.equal(persisted.metadata.approvalDecisionStatus, 'expired');
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
    assert.equal(refreshed.metadata.taskId, 'workflow-approval-reject');
    assert.equal(refreshed.metadata.executionId, 'execution-approval-reject');
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


test('synchronous workflow coordinator durably pauses and indexes an approval challenge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sync-workflow-approval-e2e-'));
  try {
    const repository = new WorkflowRepository(path.join(root, 'workflows.json'));
    const scheduler = new WorkflowScheduler({
      workflowRepository: repository,
      tenantId: 'tenant-a',
      maxRetries: 3
    });
    const coordinator = new WorkflowExecutionCoordinator({
      scheduler,
      workflowRepository: repository,
      tenantId: 'tenant-a',
      executeRequest: async () => {
        throw Object.assign(new Error('Human approval is required'), {
          code: 'APPROVAL_REQUIRED',
          executionContext: {
            executionId: 'execution-sync-coordinator',
            approvalId: 'approval-sync-coordinator'
          }
        });
      }
    });

    const result = await coordinator.execute('perform guarded work');

    assert.equal(result.type, 'workflow_waiting');
    assert.equal(result.state, 'WAITING');
    assert.equal(result.execution.metadata.approvalBlocked, true);
    assert.equal(result.execution.metadata.taskId, result.workflowId);
    assert.equal(result.execution.metadata.approvalExecutionId, 'execution-sync-coordinator');
    assert.equal(result.execution.metadata.approvalId, 'approval-sync-coordinator');
    assert.equal(result.execution.steps['agent-runtime'].state, WorkflowDefinition.STEP_STATES.PENDING);
    assert.equal(result.execution.retry.attempt, 0);

    const persisted = await repository.findByApprovalExecutionId({
      executionId: 'execution-sync-coordinator',
      tenantId: 'tenant-a'
    });
    assert.equal(persisted.workflowId, result.workflowId);
    assert.equal(persisted.state, 'WAITING');
    assert.equal(persisted.metadata.approvalBlocked, true);
    assert.equal(persisted.metadata.approvalId, 'approval-sync-coordinator');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
