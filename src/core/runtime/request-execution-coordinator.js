'use strict';

const crypto = require('crypto');
const ExecutionContext = require('../execution/execution-context');
const AgentState = require('../agent/state/agent-state');

class RequestExecutionCoordinator {
  constructor({
    agentOrchestrator,
    agentExecutionCoordinator,
    recoveryCoordinator,
    persistence,
    quotaService,
    quotaPolicy,
    persistenceCoordinator,
    tenantId,
    userId,
    workspaceId,
    maxInputChars,
    resumeLeaseDurationMs = 30000
  }) {
    if (!agentOrchestrator) throw new TypeError('agentOrchestrator is required');
    if (!agentExecutionCoordinator) throw new TypeError('agentExecutionCoordinator is required');
    if (!recoveryCoordinator) throw new TypeError('recoveryCoordinator is required');
    if (!quotaService) throw new TypeError('quotaService is required');

    this.agentOrchestrator = agentOrchestrator;
    this.agentExecutionCoordinator = agentExecutionCoordinator;
    this.recoveryCoordinator = recoveryCoordinator;
    this.persistence = persistence;
    this.quotaService = quotaService;
    this.persistenceCoordinator = persistenceCoordinator;
    this.quotaPolicy = quotaPolicy;
    this.tenantId = tenantId || 'local';
    this.userId = userId || 'local';
    this.workspaceId = workspaceId || 'local';
    this.maxInputChars = maxInputChars;
    this.resumeLeaseDurationMs = resumeLeaseDurationMs;
  }

  planFingerprint(plan) {
    if (!plan || typeof plan !== 'object') return null;

    return JSON.stringify({
      intent: plan.intent || null,
      agentId: plan.agentId || null,
      input: plan.input ?? null,
      steps: Array.isArray(plan.steps)
        ? plan.steps.map(step => ({
            step: step.step || null,
            tool: step.tool || null,
            input: step.input ?? null,
            dependsOn: step.dependsOn ?? null
          }))
        : []
    });
  }

  validateReplannedPlan(plan, previousFingerprint) {
    if (!plan || typeof plan !== 'object') {
      return { valid: false, reason: 'لم يتم إنشاء خطة جديدة' };
    }

    const fingerprint = this.planFingerprint(plan);
    if (!fingerprint) {
      return { valid: false, reason: 'تعذر إنشاء هوية للخطة الجديدة' };
    }

    if (previousFingerprint && fingerprint === previousFingerprint) {
      return { valid: false, reason: 'الخطة الجديدة مطابقة للخطة السابقة' };
    }

    return { valid: true, fingerprint };
  }

  resolveResponseType(intent) {
    return typeof intent === 'string' && intent.startsWith('memory.')
      ? 'memory_result'
      : 'tool_result';
  }

  async execute(input, { approval = null, approvals = {} } = {}) {
    const requestId = crypto.randomUUID();
    const text = String(input || '').trim();

    if (!text) return { requestId, type: 'error', message: 'لم يتم إرسال طلب.' };
    if (text.length > this.maxInputChars) {
      return {
        requestId,
        type: 'error',
        code: 'INPUT_TOO_LARGE',
        message: 'حجم الطلب يتجاوز الحد المسموح.'
      };
    }

    this.quotaService.assertTenant(this.tenantId);
    this.quotaService.assertInputSize(text);

    const context = new ExecutionContext({
      requestId,
      input: text,
      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId
    });

    context.start();
    context.record('goal.created', context.goal.snapshot());
    context.metadata.tenantQuota = this.quotaPolicy.toJSON();
    context.record('request.understood', { inputLength: text.length });
    await this.persistenceCoordinator.persistExecution(context, 'insert');

    try {
      context.transitionAgentTo(AgentState.LIFECYCLE.PLANNING);
      const orchestration = await this.agentOrchestrator.plan(text, context);
      const executionResult = await this.agentExecutionCoordinator.run({
        context,
        plan: orchestration.plan,
        validation: orchestration.validation,
        planRevision: 1,
        replans: 0,
        previousFingerprint: this.planFingerprint(orchestration.plan),
        approval,
        approvals,
        requestId,
        input: text,
        tenantId: this.tenantId
      });

      const { plan, loopResult, replanningDecision } = executionResult;
      context.complete();
      await this.persistenceCoordinator.persistExecution(context, 'update');
      await this.persistenceCoordinator.persistEvents(context);

      const result = loopResult.result;
      return {
        requestId,
        type: this.resolveResponseType(plan.intent),
        query: plan.intent === 'memory.search' ? plan.input : '',
        count: result && Array.isArray(result.memories) ? result.memories.length : undefined,
        result,
        evaluation: loopResult.evaluation,
        replanning: replanningDecision.toJSON(),
        execution: context.snapshot()
      };
    } catch (error) {
      if (error?.code === 'APPROVAL_REQUIRED') {
        context.record('approval.challenge.persisted', {
          executionId: context.executionId,
          step: error.executionContext?.step || null,
          planRevision: error.executionContext?.planRevision || 1,
          operationId: error.executionContext?.operationId || null
        });
        await this.persistenceCoordinator.checkpoint(
          context,
          'update',
          'approval_required'
        );
        await this.persistenceCoordinator.persistEvents(context);
        throw error;
      }

      await this.recoveryCoordinator.fail({ context, error });
      throw error;
    }
  }

  async resume(executionId, { approval = null, approvals = {} } = {}) {
    if (!this.persistence?.checkpoints?.findLatest) {
      throw Object.assign(new Error('Durable checkpoint storage is required for resume'), {
        code: 'CHECKPOINT_STORAGE_REQUIRED'
      });
    }

    const checkpoint = this.persistence.checkpoints.findLatest(executionId, {
      tenantId: this.tenantId
    });
    if (!checkpoint) {
      throw Object.assign(new Error(`No checkpoint found for execution: ${executionId}`), {
        code: 'CHECKPOINT_NOT_FOUND'
      });
    }

    const context = ExecutionContext.restore(checkpoint.snapshot);
    this.quotaService.assertTenant(context.tenantId || this.tenantId);
    this.quotaService.assertInputSize(context.input);

    if (!context.tenantId) context.tenantId = this.tenantId;
    if (!context.userId) context.userId = this.userId;
    if (!context.workspaceId) context.workspaceId = this.workspaceId;
    context.metadata = {
      ...context.metadata,
      tenantId: context.tenantId,
      userId: context.userId,
      workspaceId: context.workspaceId
    };

    if (context.tenantId !== this.tenantId) {
      throw Object.assign(new Error('Checkpoint tenant does not match runtime tenant'), {
        code: 'TENANT_CONTEXT_MISMATCH'
      });
    }

    // Reconcile a crash window where execution persistence reached a terminal
    // state before the corresponding checkpoint update. The durable execution
    // record is authoritative for terminal state; never re-run side effects.
    const durableExecution = typeof this.persistence?.executions?.findById === 'function'
      ? this.persistence.executions.findById(executionId, { tenantId: this.tenantId })
      : null;

    if (durableExecution && ['completed', 'failed', 'cancelled'].includes(durableExecution.status)) {
      if (typeof this.persistence.checkpoints.save === 'function') {
        this.persistence.checkpoints.save(
          durableExecution,
          { reason: 'recovery_reconciled_terminal', tenantId: this.tenantId }
        );
      }

      return {
        resumed: false,
        reason: 'execution_already_terminal',
        reconciled: true,
        execution: durableExecution
      };
    }

    if (context.status === 'created') context.resume();

    if (!context.isActive()) {
      return {
        resumed: false,
        reason: 'execution_not_resumable',
        execution: context.snapshot()
      };
    }

    const resumeLease = typeof this.persistence.checkpoints.acquireResumeLease === 'function'
      ? this.persistence.checkpoints.acquireResumeLease(executionId, {
          tenantId: this.tenantId,
          leaseDurationMs: this.resumeLeaseDurationMs
        })
      : null;

    const plan = context.plan;
    if (!plan || !Array.isArray(plan.steps)) {
      throw Object.assign(new Error('Checkpoint does not contain a resumable plan'), {
        code: 'CHECKPOINT_PLAN_REQUIRED'
      });
    }

    const planRevision = Number(context.metadata?.planRevision || 1);
    if (!Number.isInteger(planRevision) || planRevision < 1) {
      throw Object.assign(new Error('Checkpoint plan revision is invalid'), {
        code: 'CHECKPOINT_PLAN_REVISION_INVALID'
      });
    }

    const replans = Number(
      context.metadata?.replans || Math.max(0, planRevision - 1)
    );

    try {
      context.record('execution.resume.started', {
        checkpointId: checkpoint.checkpointId,
        sequence: checkpoint.sequence,
        planRevision
      });

      const executionResult = await this.agentExecutionCoordinator.run({
        context,
        plan,
        validation: { valid: true, steps: plan.steps },
        planRevision,
        replans,
        previousFingerprint: this.planFingerprint(plan),
        approval,
        approvals,
        requestId: context.requestId,
        input: context.input,
        tenantId: this.tenantId,
        agentId: context.metadata?.agentId || 'ORIENT_RUNTIME',
        resumed: true
      });

      const { loopResult, replanningDecision } = executionResult;
      context.complete();
      await this.persistenceCoordinator.persistExecution(context, 'update');
      await this.persistenceCoordinator.persistEvents(context);
      await this.persistenceCoordinator.checkpoint(context, 'update', 'execution_completed');
      if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
        this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
      }

      return {
        resumed: true,
        requestId: context.requestId,
        result: loopResult.result,
        evaluation: loopResult.evaluation,
        replanning: replanningDecision.toJSON(),
        execution: context.snapshot()
      };
    } catch (error) {
      if (context.status !== 'completed') {
        await this.recoveryCoordinator.fail({
          context,
          error,
          checkpointReason: 'resume_failed'
        });
      }
      if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
        this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
      }
      throw error;
    }
  }
}

module.exports = RequestExecutionCoordinator;
