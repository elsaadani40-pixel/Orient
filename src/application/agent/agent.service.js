const AppError = require('../../core/errors/AppError');

class AgentService {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async createTask({ goal, idempotencyKey } = {}) {
    const clean = typeof goal === 'string' ? goal.trim() : '';
    if (!clean) {
      throw new AppError('الهدف مطلوب', 400, 'TASK_GOAL_REQUIRED');
    }
    if (clean.length > 5000) {
      throw new AppError('الهدف طويل جدًا', 400, 'AGENT_INPUT_TOO_LONG');
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200 ||
        /[\\r\\n\\0]/.test(idempotencyKey)) {
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
    const begun = await repository.begin({
      executionId: crypto.randomUUID(),
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
      throw new AppError(
        'هذا الطلب قيد التنفيذ أو استُخدم مفتاحه مع طلب سابق غير مكتمل',
        409,
        'IDEMPOTENCY_KEY_CONFLICT'
      );
    }

    let task;
    try {
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

  cancelExecution(executionId, options = {}) {
    return this.runtime.cancelExecution(executionId, options);
  }
}

module.exports = AgentService;
