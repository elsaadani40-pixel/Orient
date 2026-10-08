const crypto = require('crypto');

const { WorkflowDefinition, WorkflowInstance, WorkflowWorker } = require('../workflow');
const AsyncWorkflowWorker = require('../workflow/async-workflow-worker');
const DurableMissionEventSink = require('../workflow/durable-mission-event-sink');

class WorkflowExecutionCoordinator {
  constructor({
    scheduler,
    workflowRepository = null,
    persistence = null,
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
    this.missionEventSink = this.persistence?.events?.appendMissionEvent
      ? new DurableMissionEventSink({ eventRepository: this.persistence.events, workflowRepository: this.workflowRepository, tenantId: this.tenantId })
      : null;
  }

  async execute(input, {
    approval = null,
    approvals = {},
    priority = 0,
    deadlineAt = null
  } = {}) {
    const text = String(input || '').trim();

    if (!text) {
      return {
        type: 'error',
        message: 'لم يتم إرسال طلب.'
      };
    }

    const definition = new WorkflowDefinition({
      id: 'orient.request.execution',
      version: 1,
      name: 'ORIENT Request Execution',
      steps: [
        {
          id: 'agent-runtime',
          agent: 'ORIENT_RUNTIME',
          metadata: {
            executionMode: 'canonical-agent-runtime'
          }
        }
      ]
    });

    const instance = new WorkflowInstance({
      definition,
      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      input: { text }
    });

    instance.metadata.priority = priority;

    if (this.missionEventSink) this.missionEventSink.recordCreated(instance);

    if (this.scheduler.async) {
      const from = instance.state;
      await this.scheduler.enqueueDurable(instance, { priority, deadlineAt });
      if (this.missionEventSink && from !== instance.state) this.missionEventSink.recordState(instance, from, instance.state);
    } else {
      if (this.workflowRepository?.save) this.workflowRepository.save(instance);
      this.scheduler.enqueue(instance, { priority, deadlineAt });
      if (this.workflowRepository?.save) this.workflowRepository.save(instance);
      if (this.missionEventSink) this.missionEventSink.recordState(instance, 'CREATED', 'QUEUED');
    }

    const WorkerClass = this.scheduler.async
      ? AsyncWorkflowWorker
      : WorkflowWorker;

    const worker = new WorkerClass({
      scheduler: this.scheduler,
      eventSink: (event) => {
        if (this.missionEventSink) {
          this.missionEventSink.recordWorkerEvent(instance, event);
          return;
        }

        if (this.workflowRepository?.save) this.workflowRepository.save(instance);
        if (this.persistence?.events?.append) {
          this.persistence.events.append({
            id: event.eventId || crypto.randomUUID(),
            type: event.type,
            executionId: instance.workflowId,
            timestamp: event.timestamp || new Date().toISOString(),
            data: { ...(event.payload || event), tenantId: this.tenantId }
          });
        }
      },
      executor: async () => this.executeRequest(text, {
        approval,
        approvals
      })
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
