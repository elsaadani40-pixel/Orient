const crypto = require('crypto');

const { WorkflowDefinition, WorkflowInstance, WorkflowWorker } = require('../workflow');
const AsyncWorkflowWorker = require('../workflow/async-workflow-worker');
const DurableMissionEventSink = require('../workflow/durable-mission-event-sink');

class WorkflowExecutionCoordinator {
  constructor({
    scheduler,
    workflowRepository = null,
    persistence = null,
    missionEventSink = null,
    tenantId = 'local',
    userId = 'local',
    workspaceId = 'local',
    executeRequest
  } = {}) {
    if (!scheduler) throw new TypeError('scheduler is required');
    if (typeof executeRequest !== 'function') {
      throw new TypeError('executeRequest is required');
    }

    this.scheduler = scheduler;
    this.workflowRepository = workflowRepository;
    this.persistence = persistence;
    this.tenantId = tenantId || 'local';
    this.userId = userId || 'local';
    this.workspaceId = workspaceId || 'local';
    this.executeRequest = executeRequest;
    this.missionEventSink = missionEventSink || (this.persistence?.events?.appendMissionEvent
      ? new DurableMissionEventSink({ eventRepository: this.persistence.events, workflowRepository: this.workflowRepository, tenantId: this.tenantId })
      : null);
  }

  createInstance(input, { priority = 0, deadlineAt = null, workflowId = undefined } = {}) {
    const text = String(input || '').trim();
    if (!text) {
      return { error: { type: 'error', message: 'لم يتم إرسال طلب.' } };
    }

    const definition = new WorkflowDefinition({
      id: 'orient.request.execution',
      version: 1,
      name: 'ORIENT Request Execution',
      steps: [{
        id: 'agent-runtime',
        agent: 'ORIENT_RUNTIME',
        metadata: { executionMode: 'canonical-agent-runtime' }
      }]
    });

    const instance = new WorkflowInstance({
      definition,
      workflowId,
      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      input: { text }
    });
    // Keep the public task ID aligned with the durable workflow record.
    instance.metadata = { ...instance.metadata, taskId: instance.workflowId, priority };
    return { instance, text };
  }

  async enqueue(input, { priority = 0, deadlineAt = null, workflowId = undefined, persistencePrincipal = null } = {}) {
    if (!this.scheduler.async || typeof this.scheduler.enqueueDurable !== 'function') {
      throw Object.assign(
        new Error('Durable asynchronous workflow scheduling requires an async scheduler'),
        { code: 'ASYNC_WORKFLOW_SCHEDULER_REQUIRED' }
      );
    }

    const created = this.createInstance(input, { priority, deadlineAt, workflowId });
    if (created.error) return created.error;
    const { instance } = created;

    instance.transition('QUEUED');
    instance.setDeadline(deadlineAt);
    let durableAlreadyPersisted = false;
    if (this.missionEventSink) {
      await this.missionEventSink.recordCreation(instance, { persistencePrincipal });
      durableAlreadyPersisted = true;
    }
    await this.scheduler.enqueueDurable(instance, { priority, deadlineAt, durableAlreadyPersisted });

    return {
      workflowId: instance.workflowId,
      state: instance.state,
      tenantId: instance.tenantId,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt
    };
  }

  async findApprovalBlockedWorkflow(executionId, persistencePrincipal = null) {
    if (!executionId || typeof this.workflowRepository?.findAll !== 'function') return null;
    const payload = typeof this.workflowRepository.findByApprovalExecutionId === 'function'
      ? await this.workflowRepository.findByApprovalExecutionId({ executionId: String(executionId), tenantId: this.tenantId, ...(persistencePrincipal ? { persistencePrincipal } : {}) })
      : (await this.workflowRepository.findAll({ tenantId: this.tenantId, ...(persistencePrincipal ? { persistencePrincipal } : {}) })).find(record =>
          record?.tenantId === this.tenantId &&
          record?.metadata?.approvalBlocked === true &&
          String(record.metadata.approvalExecutionId || '') === String(executionId)
        );
    return payload ? WorkflowInstance.fromJSON(payload) : null;
  }

  async persistApprovalWorkflow(instance, fromState = instance.state, persistencePrincipal = null) {
    if (typeof this.workflowRepository?.save !== 'function') {
      throw Object.assign(new Error('Durable workflow storage is required to reconcile approval'), {
        code: 'WORKFLOW_STORAGE_REQUIRED'
      });
    }
    // The workflow worker releases its lease while awaiting human approval.
    // Never reuse the old fencing token for this owner-authorized resolution write.
    if (instance.metadata?.fencingToken !== undefined) {
      instance.metadata = { ...instance.metadata };
      delete instance.metadata.fencingToken;
    }
    if (this.missionEventSink) {
      await this.missionEventSink.recordSnapshot(instance, 'approval_resolution', {
        ...(persistencePrincipal ? { persistencePrincipal } : {})
      });
    } else {
      await this.workflowRepository.save(instance, this.tenantId, persistencePrincipal ? { persistencePrincipal } : {});
    }
    return instance.toJSON();
  }

  async updateApprovalChallenge(executionId, approvalId, persistencePrincipal = null) {
    if (typeof approvalId !== 'string' || !approvalId) return false;
    const instance = await this.findApprovalBlockedWorkflow(executionId, persistencePrincipal);
    if (!instance) return false;
    instance.metadata = {
      ...instance.metadata,
      approvalBlocked: true,
      taskId: instance.metadata.taskId || instance.workflowId,
      executionId: String(executionId),
      approvalExecutionId: String(executionId),
      approvalId,
      approvalRequiredAt: new Date().toISOString()
    };
    await this.persistApprovalWorkflow(instance, instance.state, persistencePrincipal);
    return true;
  }

  async reconcileApprovalResume(executionId, resumeResult, persistencePrincipal = null) {
    const instance = await this.findApprovalBlockedWorkflow(executionId, persistencePrincipal);
    if (!instance) return false;
    const execution = resumeResult?.execution || null;
    const status = String(execution?.status || '').toLowerCase();
    if (!['completed', 'failed', 'cancelled'].includes(status)) return false;

    const fromState = instance.state;
    const stepId = instance.definition.steps[0]?.id;
    if (!stepId || !instance.steps[stepId]) {
      throw Object.assign(new Error('Approval-blocked workflow has no resumable step'), {
        code: 'WORKFLOW_APPROVAL_STEP_MISSING'
      });
    }

    if (status === 'completed') {
      if (instance.state === WorkflowInstance.STATES.WAITING) instance.transition(WorkflowInstance.STATES.RUNNING);
      if (instance.steps[stepId].state !== WorkflowDefinition.STEP_STATES.COMPLETED) {
        if (instance.steps[stepId].state !== WorkflowDefinition.STEP_STATES.PENDING) {
          throw Object.assign(new Error('Approval-blocked workflow step is not pending'), {
            code: 'WORKFLOW_APPROVAL_STEP_NOT_PENDING'
          });
        }
        instance.markStepRunning(stepId);
        instance.markStepCompleted(stepId, {
          executionId: String(executionId),
          result: resumeResult?.result ?? null,
          executionStatus: status
        });
      }
      instance.transition(WorkflowInstance.STATES.COMPLETED);
      instance.metadata.approvalDecisionStatus = 'approved';
    } else if (status === 'cancelled') {
      instance.transition(WorkflowInstance.STATES.CANCELLED);
      instance.metadata.approvalDecisionStatus = instance.metadata.approvalDecisionStatus === 'rejected' ? 'rejected' : 'cancelled';
    } else {
      instance.steps[stepId].state = WorkflowDefinition.STEP_STATES.FAILED;
      instance.steps[stepId].error = {
        code: execution?.metadata?.failureCode || 'EXECUTION_FAILED',
        message: 'The approved execution failed during resume'
      };
      instance.transition(WorkflowInstance.STATES.FAILED);
      instance.metadata.approvalDecisionStatus = 'approved_execution_failed';
    }

    instance.metadata = {
      ...instance.metadata,
      approvalBlocked: false,
      approvalResolvedAt: new Date().toISOString()
    };
    await this.persistApprovalWorkflow(instance, fromState, persistencePrincipal);
    return instance.toJSON();
  }

  async expireApprovalWorkflow(executionId, approvalId, persistencePrincipal = null) {
    if (!executionId || typeof approvalId !== 'string' || !approvalId) return false;
    const instance = await this.findApprovalBlockedWorkflow(executionId, persistencePrincipal);
    if (!instance || instance.metadata?.approvalId !== approvalId) return false;
    if ([WorkflowInstance.STATES.CANCELLED, WorkflowInstance.STATES.COMPLETED, WorkflowInstance.STATES.FAILED].includes(instance.state)) {
      return instance.toJSON();
    }

    const fromState = instance.state;
    instance.requestCancel();
    instance.transition(WorkflowInstance.STATES.CANCELLED);
    instance.metadata = {
      ...instance.metadata,
      approvalBlocked: false,
      approvalDecisionStatus: 'expired',
      approvalResolvedAt: new Date().toISOString(),
      cancellationReason: 'approval_expired'
    };
    await this.persistApprovalWorkflow(instance, fromState, persistencePrincipal);
    return instance.toJSON();
  }

  async cancelApprovalWorkflow(executionId, reason = 'owner_rejected', persistencePrincipal = null) {
    const instance = await this.findApprovalBlockedWorkflow(executionId, persistencePrincipal);
    if (!instance) return false;
    const fromState = instance.state;
    if (![WorkflowInstance.STATES.CANCELLED, WorkflowInstance.STATES.COMPLETED, WorkflowInstance.STATES.FAILED].includes(instance.state)) {
      instance.requestCancel();
      instance.transition(WorkflowInstance.STATES.CANCELLED);
    }
    instance.metadata = {
      ...instance.metadata,
      approvalBlocked: false,
      approvalDecisionStatus: ['owner_rejected', 'approval_rejected'].includes(String(reason)) ? 'rejected' : 'cancelled',
      approvalResolvedAt: new Date().toISOString(),
      cancellationReason: String(reason).slice(0, 300)
    };
    await this.persistApprovalWorkflow(instance, fromState, persistencePrincipal);
    return instance.toJSON();
  }

  async execute(input, {
    approval = null,
    approvals = {},
    priority = 0,
    deadlineAt = null,
    persistencePrincipal = null
  } = {}) {
    const created = this.createInstance(input, { priority, deadlineAt });
    if (created.error) return created.error;
    const { instance, text } = created;

    let durableAlreadyPersisted = false;
    if (this.scheduler.async) {
      instance.transition('QUEUED');
      instance.setDeadline(deadlineAt);
      if (this.missionEventSink) {
        await this.missionEventSink.recordCreation(instance, { persistencePrincipal });
        durableAlreadyPersisted = true;
      }
      await this.scheduler.enqueueDurable(instance, { priority, deadlineAt, durableAlreadyPersisted });
    } else {
      if (this.missionEventSink) {
        instance.transition('QUEUED');
        instance.setDeadline(deadlineAt);
        await this.missionEventSink.recordCreation(instance, { persistencePrincipal });
        if (typeof this.scheduler.enqueuePersisted === 'function') {
          this.scheduler.enqueuePersisted(instance, { priority, deadlineAt });
        } else {
          this.scheduler.enqueue(instance, { priority, deadlineAt });
        }
      } else {
        this.scheduler.enqueue(instance, { priority, deadlineAt });
        if (this.workflowRepository?.save) await this.workflowRepository.save(instance, this.tenantId);
      }
    }

    const WorkerClass = this.scheduler.async
      ? AsyncWorkflowWorker
      : WorkflowWorker;

    const worker = new WorkerClass({
      scheduler: this.scheduler,
      eventSink: async (event) => {
        if (this.missionEventSink) {
          return this.missionEventSink.recordWorkerEvent(instance, event);
        }

        if (this.workflowRepository?.save) {
          await this.workflowRepository.save(instance, this.tenantId, {
            workerPrincipal: event.workerPrincipal || null
          });
        }
        if (this.persistence?.events?.append) {
          return this.persistence.events.append({
            id: event.eventId || crypto.randomUUID(),
            type: event.type,
            executionId: instance.workflowId,
            timestamp: event.timestamp || new Date().toISOString(),
            data: { ...(event.payload || event), tenantId: this.tenantId }
          }, { tenantId: this.tenantId });
        }
        return null;
      },
      persistAfterTick: !(this.missionEventSink && this.workflowRepository?.save),
      executor: async () => this.executeRequest(text, { approval, approvals })
    });

    const completed = await worker.tick();

    if (!completed) {
      throw Object.assign(
        new Error('Workflow could not acquire a worker lease'),
        { code: 'WORKFLOW_LEASE_UNAVAILABLE' }
      );
    }

    if (completed.state === WorkflowInstance.STATES.COMPLETED) {
      return completed.steps['agent-runtime'].result;
    }

    if (completed.state === WorkflowInstance.STATES.WAITING) {
      return {
        type: 'workflow_waiting',
        workflowId: completed.workflowId,
        state: completed.state,
        retry: completed.retry,
        execution: completed.toJSON()
      };
    }

    throw Object.assign(
      new Error(
        completed.steps['agent-runtime']?.error?.message ||
        'Workflow execution failed'
      ),
      {
        code:
          completed.steps['agent-runtime']?.error?.code ||
          'WORKFLOW_EXECUTION_FAILED'
      }
    );
  }
}

module.exports = WorkflowExecutionCoordinator;
