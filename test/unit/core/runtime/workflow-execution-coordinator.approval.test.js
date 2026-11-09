'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');
const WorkflowRepository = require('../../../../src/infrastructure/persistence/json/workflow.repository');
const EventRepository = require('../../../../src/infrastructure/persistence/json/event.repository');
const MissionEventRecovery = require('../../../../src/core/workflow/mission-event-recovery');
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
    const events = new EventRepository(path.join(root, 'events.json'));
    const scheduler = new WorkflowScheduler({
      workflowRepository: repository,
      tenantId: 'tenant-a',
      maxRetries: 3
    });
    const coordinator = new WorkflowExecutionCoordinator({
      scheduler,
      workflowRepository: repository,
      persistence: { workflows: repository, events },
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

    const missionEvents = events.findByAggregateId(result.workflowId, { tenantId: 'tenant-a' });
    assert.ok(missionEvents.some(event => event.type === 'workflow.step.running'));
    assert.ok(missionEvents.some(event => event.type === 'workflow.approval.required'));
    const recovery = new MissionEventRecovery({ eventRepository: events, workflowRepository: repository });
    const recovered = await recovery.reconcile(result.workflowId, 'tenant-a');
    assert.equal(recovered.workflow.state, 'WAITING');
    assert.equal(recovered.workflow.metadata.approvalBlocked, true);
    assert.equal(recovered.workflow.steps['agent-runtime'].state, WorkflowDefinition.STEP_STATES.PENDING);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workflow cancellation distinguishes owner rejection from general cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-cancel-reason-'));
  try {
    const { repository, coordinator } = createCoordinator(root);
    await saveApprovalBlockedWorkflow(repository, {
      workflowId: 'workflow-user-cancelled',
      executionId: 'execution-user-cancelled',
      approvalId: 'approval-user-cancelled'
    });
    await coordinator.cancelApprovalWorkflow('execution-user-cancelled', 'user_cancelled');
    const userCancelled = (await repository.findAll({ tenantId: 'tenant-a' }))
      .find(record => record.workflowId === 'workflow-user-cancelled');
    assert.equal(userCancelled.metadata.approvalDecisionStatus, 'cancelled');

    await saveApprovalBlockedWorkflow(repository, {
      workflowId: 'workflow-owner-rejected',
      executionId: 'execution-owner-rejected',
      approvalId: 'approval-owner-rejected'
    });
    await coordinator.cancelApprovalWorkflow('execution-owner-rejected', 'owner_rejected');
    const ownerRejected = (await repository.findAll({ tenantId: 'tenant-a' }))
      .find(record => record.workflowId === 'workflow-owner-rejected');
    assert.equal(ownerRejected.metadata.approvalDecisionStatus, 'rejected');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('approval resume appends a replayable snapshot event before durable state replacement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-event-recovery-'));
  try {
    const workflows = new WorkflowRepository(path.join(root, 'workflows.json'));
    const events = new EventRepository(path.join(root, 'events.json'));
    const coordinator = new WorkflowExecutionCoordinator({
      scheduler: {},
      workflowRepository: workflows,
      persistence: { workflows, events },
      tenantId: 'tenant-a',
      executeRequest: async () => ({ ok: true })
    });
    const instance = await saveApprovalBlockedWorkflow(workflows, {
      workflowId: 'workflow-approval-event',
      executionId: 'execution-approval-event',
      approvalId: 'approval-event'
    });
    await coordinator.missionEventSink.recordCreated(instance);
    const result = await coordinator.reconcileApprovalResume('execution-approval-event', {
      result: { approved: true },
      execution: { executionId: 'execution-approval-event', status: 'completed' }
    });
    assert.equal(result.state, WorkflowInstance.STATES.COMPLETED);
    const eventTypes = events.findByAggregateId(instance.workflowId, { tenantId: 'tenant-a' }).map(event => event.type);
    assert.deepEqual(eventTypes, ['workflow.created', 'workflow.snapshot.replaced']);
    const recovery = new MissionEventRecovery({ eventRepository: events, workflowRepository: workflows });
    const recovered = await recovery.reconcile(instance.workflowId, 'tenant-a');
    assert.equal(recovered.status, 'HEALTHY');
    assert.equal(recovered.workflow.state, WorkflowInstance.STATES.COMPLETED);
    assert.equal(recovered.workflow.metadata.approvalBlocked, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('approval workflow reconciliation forwards the authenticated owner principal to repository reads and writes', async () => {
  const { createPersistencePrincipal } = require('../../../../src/core/security/persistence-principal');
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a'
  });
  const definition = new WorkflowDefinition({
    id: 'orient.request.execution', version: 1, name: 'ORIENT Request Execution',
    steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME' }]
  });
  const instance = new WorkflowInstance({
    definition, workflowId: 'workflow-owner-approval', tenantId: 'tenant-a',
    userId: 'owner-a', workspaceId: 'workspace-a', input: { text: 'guarded work' }
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  instance.transition('WAITING');
  instance.metadata = {
    ...instance.metadata, approvalBlocked: true,
    approvalExecutionId: 'execution-owner-approval',
    approvalId: 'approval-old'
  };
  const calls = [];
  const workflowRepository = {
    async findAll() { return [instance.toJSON()]; },
    async findByApprovalExecutionId(options) {
      calls.push(['find', options]);
      return instance.toJSON();
    },
    async save(value, tenantId, options) {
      calls.push(['save', tenantId, options]);
      return value.toJSON();
    }
  };
  const coordinator = new WorkflowExecutionCoordinator({
    scheduler: {}, workflowRepository, tenantId: 'tenant-a',
    userId: 'owner-a', workspaceId: 'workspace-a', executeRequest: async () => ({})
  });

  assert.equal(await coordinator.updateApprovalChallenge(
    'execution-owner-approval', 'approval-new', principal
  ), true);
  assert.equal(calls[0][0], 'find');
  assert.strictEqual(calls[0][1].persistencePrincipal, principal);
  assert.equal(calls[1][0], 'save');
  assert.equal(calls[1][1], 'tenant-a');
  assert.strictEqual(calls[1][2].persistencePrincipal, principal);
});


test('shared mission event sink receives owner principal during approval snapshot replacement', async () => {
  const { createPersistencePrincipal } = require('../../../../src/core/security/persistence-principal');
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a'
  });
  const instance = new WorkflowInstance({
    definition: new WorkflowDefinition({
      id: 'owner-approval-sink', version: 1, name: 'Owner approval sink',
      steps: [{ id: 'work', tool: 'work' }]
    }),
    workflowId: 'workflow-owner-sink',
    tenantId: 'tenant-a',
    userId: 'owner-a'
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  instance.transition('WAITING');
  instance.metadata = { ...instance.metadata, approvalBlocked: true, approvalExecutionId: 'execution-owner-sink' };
  const calls = [];
  const workflowRepository = {
    async findByApprovalExecutionId() { return instance.toJSON(); },
    async findAll() { return [instance.toJSON()]; },
    async save() { throw new Error('shared mission event sink should own the durable write'); }
  };
  const missionEventSink = {
    async recordSnapshot(value, reason, options) {
      calls.push({ workflowId: value.workflowId, reason, persistencePrincipal: options.persistencePrincipal });
    }
  };
  const coordinator = new WorkflowExecutionCoordinator({
    scheduler: {}, workflowRepository, missionEventSink, tenantId: 'tenant-a',
    userId: 'owner-a', workspaceId: 'workspace-a', executeRequest: async () => ({})
  });
  await coordinator.updateApprovalChallenge('execution-owner-sink', 'approval-new', principal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'approval_resolution');
  assert.strictEqual(calls[0].persistencePrincipal, principal);
});


test('approval resume, expiry, and cancellation consistently propagate owner persistence authority', async () => {
  const { createPersistencePrincipal } = require('../../../../src/core/security/persistence-principal');
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-owner-a'
  });

  async function runCase(action) {
    const definition = new WorkflowDefinition({
      id: 'owner-approval-lifecycle', version: 1, name: 'Owner approval lifecycle',
      steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME' }]
    });
    const instance = new WorkflowInstance({
      definition, workflowId: `workflow-owner-${action}`, tenantId: 'tenant-a',
      userId: 'owner-a', workspaceId: 'workspace-a', input: { text: 'guarded operation' }
    });
    instance.transition('QUEUED');
    instance.transition('RUNNING');
    instance.transition('WAITING');
    instance.metadata = {
      ...instance.metadata, approvalBlocked: true,
      approvalExecutionId: `execution-owner-${action}`,
      approvalId: `approval-owner-${action}`
    };

    const calls = [];
    const workflowRepository = {
      async findAll() { return [instance.toJSON()]; },
      async findByApprovalExecutionId(options) {
        calls.push({ kind: 'find', options });
        return instance.toJSON();
      },
      async save(value, tenantId, options) {
        calls.push({ kind: 'save', tenantId, options });
        return value.toJSON();
      }
    };
    const coordinator = new WorkflowExecutionCoordinator({
      scheduler: {}, workflowRepository, tenantId: 'tenant-a',
      userId: 'owner-a', workspaceId: 'workspace-a', executeRequest: async () => ({})
    });

    if (action === 'resume') {
      await coordinator.reconcileApprovalResume(`execution-owner-${action}`, {
        result: { ok: true },
        execution: { executionId: `execution-owner-${action}`, status: 'completed' }
      }, principal);
    } else if (action === 'expire') {
      await coordinator.expireApprovalWorkflow(
        `execution-owner-${action}`, `approval-owner-${action}`, principal
      );
    } else {
      await coordinator.cancelApprovalWorkflow(
        `execution-owner-${action}`, 'owner_rejected', principal
      );
    }

    const find = calls.find(call => call.kind === 'find');
    const save = calls.find(call => call.kind === 'save');
    assert.ok(find, `${action} must perform an owner-scoped read`);
    assert.ok(save, `${action} must perform an owner-scoped write`);
    assert.strictEqual(find.options.persistencePrincipal, principal);
    assert.strictEqual(save.options.persistencePrincipal, principal);
    assert.equal(save.tenantId, 'tenant-a');
  }

  await runCase('resume');
  await runCase('expire');
  await runCase('cancel');
});
