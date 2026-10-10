const AppError = require('../../core/errors/AppError');

class AgentService {
  constructor(runtime, { taskAcceptanceMode = 'sync' } = {}) {
    if (!['sync', 'async'].includes(taskAcceptanceMode)) {
      throw new TypeError('taskAcceptanceMode must be sync or async');
    }
    this.runtime = runtime;
    this.taskAcceptanceMode = taskAcceptanceMode;
  }

  async createTask({ goal, idempotencyKey } = {}) {
    const clean = typeof goal === 'string' ? goal.trim() : '';
    if (!clean) {
      throw new AppError('الهدف مطلوب', 400, 'TASK_GOAL_REQUIRED');
    }
    if (clean.length > 5000) {
      throw new AppError('الهدف طويل جدًا', 400, 'AGENT_INPUT_TOO_LONG');
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new AppError('مفتاح منع التكرار غير صالح', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }

    const repository = this.runtime.persistence?.idempotency;
    if (!repository || typeof repository.begin !== 'function' ||
        typeof repository.complete !== 'function' || typeof repository.fail !== 'function') {
      throw new AppError('Durable task idempotency storage is required', 503, 'TASK_IDEMPOTENCY_STORAGE_REQUIRED');
    }

    const crypto = require('node:crypto');
    const tenantId = this.runtime.tenantId || 'local';
    const digest = crypto.createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
    const requestDigest = crypto.createHash('sha256').update(clean, 'utf8').digest('hex');
    const operationId = 'api-v1-task-create:' + tenantId + ':' + digest;
    const submissionId = crypto.randomUUID();
    const begun = await repository.begin({
      executionId: this.taskAcceptanceMode === 'async' ? submissionId : crypto.randomUUID(),
      step: 1,
      tool: 'api.v1.tasks.create:' + requestDigest,
      planRevision: 1,
      operationId,
      tenantId
    });

    if (!begun.created) {
      if (begun.record?.tool !== 'api.v1.tasks.create:' + requestDigest) {
        throw new AppError('لا يمكن إعادة استخدام مفتاح منع التكرار لطلب مختلف', 409, 'IDEMPOTENCY_KEY_REUSED');
      }
      if (begun.record?.status === 'completed' && begun.record.result) {
        return { task: begun.record.result, replayed: true };
      }
      if (this.taskAcceptanceMode === 'async' && begun.record?.status === 'running' && begun.record.executionId) {
        const existingWorkflow = await this.findWorkflowById(begun.record.executionId);
        if (existingWorkflow) {
          const recoveredTask = this.summarizeWorkflow(existingWorkflow);
          await repository.complete(begun.key, recoveredTask, { tenantId });
          return { task: recoveredTask, replayed: true };
        }
      }
      throw new AppError(
        'هذا الطلب قيد التنفيذ أو استُخدم مفتاحه مع طلب سابق غير مكتمل',
        409,
        'IDEMPOTENCY_KEY_CONFLICT'
      );
    }

    let task;
    try {
      if (this.taskAcceptanceMode === 'async') {
        const coordinator = this.runtime.workflowExecutionCoordinator;
        if (!coordinator || typeof coordinator.enqueue !== 'function') {
          throw new AppError('Durable asynchronous task scheduling is required', 503, 'ASYNC_TASK_COORDINATOR_REQUIRED');
        }
        const accepted = await coordinator.enqueue(clean, { workflowId: begun.record.executionId });
        if (!accepted || accepted.error || !accepted.workflowId || !accepted.taskId) {
          throw new AppError('The workflow scheduler did not return a durable task identity', 502, 'TASK_WORKFLOW_ID_MISSING');
        }
        task = this.summarizeWorkflow(accepted);
      } else {
        const result = await this.execute(clean);
        const executionId = result?.execution?.executionId || result?.executionId;
        if (typeof executionId !== 'string' || !executionId) {
          throw new AppError('لم يُرجع Runtime معرّف مهمة قابلًا للتحقق', 502, 'TASK_EXECUTION_ID_MISSING');
        }

        const execution = await this.getExecutionStatus(executionId);
        task = {
          id: execution.executionId,
          status: execution.status,
          currentStep: execution.currentStep ?? null,
          createdAt: execution.startedAt || null,
          updatedAt: execution.updatedAt || null,
          completedAt: execution.completedAt || null,
          cancellationRequested: Boolean(execution.cancellationRequested),
          agentLifecycle: execution.agentLifecycle || null,
          version: 1
        };
      }
    } catch (error) {
      try {
        await repository.fail(begun.key, {
          code: error?.code || 'TASK_CREATION_FAILED',
          message: error?.message || 'Task creation failed'
        }, { tenantId });
      } catch (_) {
        // Preserve the original runtime error; the durable running record still
        // prevents a retry from silently executing the same key a second time.
      }
      throw error;
    }

    await repository.complete(begun.key, task, { tenantId });
    return { task, replayed: false };
  }

  async findWorkflowById(workflowId) {
    const repository = this.runtime.workflowExecutionCoordinator?.workflowRepository || this.runtime.persistence?.workflows;
    if (!repository || typeof repository.findById !== 'function') return null;
    return repository.findById(workflowId, this.runtime.tenantId || 'local');
  }

  summarizeWorkflow(value) {
    const workflow = value && typeof value.toJSON === 'function' ? value.toJSON() : (value || {});
    const metadata = workflow.metadata || {};
    const workflowId = workflow.workflowId || value?.workflowId || null;
    const id = metadata.taskId || value?.taskId || workflowId;
    const state = String(workflow.state || value?.state || 'QUEUED').toLowerCase();
    return {
      id,
      status: state,
      currentStep: null,
      createdAt: workflow.createdAt || value?.createdAt || null,
      updatedAt: workflow.updatedAt || value?.updatedAt || workflow.createdAt || value?.createdAt || null,
      completedAt: workflow.completedAt || value?.completedAt || null,
      cancellationRequested: Boolean(workflow.cancelRequested || workflow.cancellationRequested || metadata.cancellationRequested),
      workflowId: workflowId || id,
      executionId: metadata.executionId || metadata.approvalExecutionId || value?.executionId || null,
      approvalRequired: Boolean(metadata.approvalBlocked || value?.approvalBlocked),
      version: 1
    };
  }

  async listTasks({ limit = 20, offset = 0 } = {}) {
    if (this.taskAcceptanceMode !== 'async') return this.listExecutionSummaries({ limit, offset });
    const repository = this.runtime.workflowExecutionCoordinator?.workflowRepository || this.runtime.persistence?.workflows;
    if (!repository || typeof repository.findAll !== 'function') {
      throw new AppError('Durable workflow storage is required for async task listing', 503, 'WORKFLOW_STORAGE_REQUIRED');
    }
    const tenantId = this.runtime.tenantId || 'local';
    const workflows = await repository.findAll({ tenantId });
    const tasks = workflows
      .map(workflow => this.summarizeWorkflow(workflow))
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    return {
      executions: tasks.slice(offset, offset + limit).map(task => ({
        executionId: task.id,
        status: task.status,
        currentStep: task.currentStep,
        startedAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        cancellationRequested: task.cancellationRequested,
        workflowId: task.workflowId,
        canonicalExecutionId: task.executionId,
        approvalRequired: task.approvalRequired
      })),
      limit,
      offset,
      total: tasks.length
    };
  }

  async getTaskStatus(taskId) {
    if (this.taskAcceptanceMode !== 'async') {
      const execution = await this.getExecutionStatus(taskId);
      return {
        id: execution.executionId,
        status: execution.status,
        currentStep: execution.currentStep ?? null,
        createdAt: execution.startedAt || null,
        updatedAt: execution.updatedAt || null,
        completedAt: execution.completedAt || null,
        cancellationRequested: Boolean(execution.cancellationRequested),
        agentLifecycle: execution.agentLifecycle || null,
        version: 1
      };
    }
    const workflow = await this.findWorkflowById(taskId);
    if (!workflow) throw new AppError('Task not found', 404, 'TASK_NOT_FOUND');
    return this.summarizeWorkflow(workflow);
  }

  async getTaskEvents(taskId, options = {}) {
    if (this.taskAcceptanceMode !== 'async') return this.getExecutionEvents(taskId, options);
    const task = await this.getTaskStatus(taskId);
    const events = this.runtime.persistence?.events;
    if (!events || typeof events.findByExecutionId !== 'function') {
      throw new AppError('Durable task event storage is required', 503, 'TASK_EVENT_STORAGE_REQUIRED');
    }
    const executionId = task.executionId || task.workflowId || task.id;
    return events.findByExecutionId(executionId, { ...options, tenantId: this.runtime.tenantId || 'local' });
  }

  execute(input) {
    const clean = String(input || '').trim();

    if (!clean) {
      throw new AppError(
        'الطلب مطلوب',
        400,
        'AGENT_INPUT_REQUIRED'
      );
    }

    if (clean.length > 5000) {
      throw new AppError(
        'الطلب طويل جدًا',
        400,
        'AGENT_INPUT_TOO_LONG'
      );
    }

    return this.runtime.execute(clean);
  }

  listExecutionSummaries(options = {}) {
    return this.runtime.listExecutionSummaries(options);
  }

  listPendingApprovals(options = {}) {
    return this.runtime.listPendingApprovals(options);
  }

  getExecutionEvents(executionId, options = {}) {
    return this.runtime.getExecutionEvents(executionId, options);
  }

  getExecutionStatus(executionId) {
    return this.runtime.getExecutionStatus(executionId);
  }

  getExecutionApprovals(executionId) {
    return this.runtime.getExecutionApprovals(executionId);
  }

  resumeExecution(executionId, options = {}) {
    return this.runtime.resume(executionId, options);
  }

  decideApproval(options = {}) {
    return this.runtime.decideApproval(options);
  }

  cancelExecution(executionId, options = {}) {
    return this.runtime.cancelExecution(executionId, options);
  }
}

module.exports = AgentService;
