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
    approvalService = null,
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
    this.approvalService = approvalService;
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

  async isCancellationRequested(executionId) {
    if (!executionId || typeof this.persistence?.executions?.findById !== 'function') return false;
    const execution = await this.persistence.executions.findById(executionId, { tenantId: this.tenantId });
    return Boolean(execution?.cancellationRequested);
  }

  async reconcileCancellationAfterFailure(context, executionId, activeSnapshot = null) {
    const durableExecution = typeof this.persistence?.executions?.findById === 'function'
      ? await this.persistence.executions.findById(executionId, { tenantId: this.tenantId })
      : null;

    if (!durableExecution?.cancellationRequested && durableExecution?.status !== 'cancelled') {
      return null;
    }

    const cancellationReason = durableExecution.cancellationReason || 'Execution cancellation requested';
    const reconciledContext = activeSnapshot
      ? ExecutionContext.restore(activeSnapshot)
      : context;

    if (reconciledContext.isActive()) {
      reconciledContext.requestCancellation(cancellationReason);
      reconciledContext.cancel(cancellationReason);
    }

    const persisted = await this.persistenceCoordinator.persistExecution(reconciledContext, 'update');
    await this.persistenceCoordinator.persistEvents(reconciledContext);
    await this.persistenceCoordinator.checkpoint(reconciledContext, 'update', 'execution_cancelled');

    return {
      context: reconciledContext,
      execution: persisted || durableExecution || reconciledContext.snapshot()
    };
  }

  snapshotActiveContext(context) {
    if (!context?.isActive()) return null;
    return {
      ...context.snapshot(),
      // snapshot() retains the live events array; isolate it before recovery
      // can append terminal failure events.
      events: context.events.map(event => ({
        ...event,
        data: { ...(event.data || {}) }
      }))
    };
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

    let context = new ExecutionContext({
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
        tenantId: this.tenantId,
        isCancellationRequested: () => this.isCancellationRequested(context.executionId),
        cancellationReason: 'Execution cancellation requested'
      });

      const { plan, loopResult, replanningDecision } = executionResult;
      const activeContextSnapshot = {
        ...context.snapshot(),
        // snapshot() retains the live events array; copy it before the
        // speculative completion mutates the context.
        events: context.events.map(event => ({
          ...event,
          data: { ...(event.data || {}) }
        }))
      };
      context.complete();
      const persistedExecution = await this.persistenceCoordinator.persistExecution(context, 'update');

      // Some lightweight runtimes intentionally omit an execution repository.
      // Enforce divergence checks whenever durable state is available; absence
      // of a persistence adapter is not itself an outcome conflict.
      if (persistedExecution?.cancellationRequested || persistedExecution?.status === 'cancelled') {
        const cancellationReason = persistedExecution.cancellationReason || 'Execution cancellation requested';
        context = ExecutionContext.restore(activeContextSnapshot);
        context.requestCancellation(cancellationReason);
        context.cancel(cancellationReason);
        const durableCancellation = await this.persistenceCoordinator.persistExecution(context, 'update');
        await this.persistenceCoordinator.persistEvents(context);
        await this.persistenceCoordinator.checkpoint(context, 'update', 'execution_cancelled');
        return {
          requestId,
          type: 'execution_cancelled',
          execution: durableCancellation || context.snapshot()
        };
      }

      if (persistedExecution && persistedExecution.status !== context.status) {
        throw Object.assign(new Error('Execution outcome persistence diverged from runtime state'), {
          code: 'EXECUTION_OUTCOME_DIVERGENCE'
        });
      }

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
      // Lease loss is a concurrency-control failure, not an execution failure.
      // Preserve the resumable checkpoint rather than committing a terminal
      // failure after another worker may have acquired ownership.
      if (error?.code === 'CHECKPOINT_RESUME_LEASE_RENEWAL_UNSUPPORTED' ||
          error?.code === 'CHECKPOINT_RESUME_LEASE_LOST') {
        if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
          await this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
        }
        throw error;
      }

      if (error?.code === 'EXECUTION_CANCELLATION_REQUESTED') {
        if (context.isActive()) context.cancel(context.cancellationReason || 'Execution cancelled');
        await this.persistenceCoordinator.checkpoint(context, 'update', 'execution_cancelled');
        await this.persistenceCoordinator.persistEvents(context);
        return { requestId, type: 'execution_cancelled', execution: context.snapshot() };
      }

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

      const activeSnapshot = this.snapshotActiveContext(context);
      const cancellationBeforeRecovery = await this.reconcileCancellationAfterFailure(
        context,
        context.executionId,
        activeSnapshot
      );
      if (cancellationBeforeRecovery) {
        return {
          requestId,
          type: 'execution_cancelled',
          execution: cancellationBeforeRecovery.execution
        };
      }

      await this.recoveryCoordinator.fail({ context, error });

      // If cancellation arrived while recovery was committing a failure, the
      // repository refuses that terminal write. Reconcile the durable intent
      // before returning the original tool error to the caller.
      const cancellationAfterRecovery = await this.reconcileCancellationAfterFailure(
        context,
        context.executionId,
        activeSnapshot
      );
      if (cancellationAfterRecovery) {
        return {
          requestId,
          type: 'execution_cancelled',
          execution: cancellationAfterRecovery.execution
        };
      }
      throw error;
    }
  }


  createResumeLeaseHeartbeat(renewLease, intervalMs) {
    if (typeof renewLease !== 'function') throw new TypeError('renewLease is required');
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new TypeError('intervalMs must be a positive integer');
    }

    let stopped = false;
    let renewalError = null;
    let inFlight = null;

    const renewOnce = () => {
      if (renewalError) return Promise.reject(renewalError);
      if (inFlight) return inFlight;
      inFlight = Promise.resolve()
        .then(renewLease)
        .catch(error => {
          renewalError = error;
          throw error;
        })
        .finally(() => { inFlight = null; });
      return inFlight;
    };

    const timer = setInterval(() => {
      if (stopped || renewalError || inFlight) return;
      // The stored error is surfaced at the next checkpoint or when the
      // execution settles; never create an unhandled timer rejection.
      renewOnce().catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
      renew: renewOnce,
      async stop() {
        stopped = true;
        clearInterval(timer);
        if (inFlight) await inFlight.catch(() => {});
        if (renewalError) throw renewalError;
      }
    };
  }

  async resume(executionId, { approval = null, approvals = {} } = {}) {
    if (!this.persistence?.checkpoints?.findLatest) {
      throw Object.assign(new Error('Durable checkpoint storage is required for resume'), {
        code: 'CHECKPOINT_STORAGE_REQUIRED'
      });
    }

    const checkpoint = await this.persistence.checkpoints.findLatest(executionId, {
      tenantId: this.tenantId
    });
    if (!checkpoint) {
      throw Object.assign(new Error(`No checkpoint found for execution: ${executionId}`), {
        code: 'CHECKPOINT_NOT_FOUND'
      });
    }

    let context = ExecutionContext.restore(checkpoint.snapshot);
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
      ? await this.persistence.executions.findById(executionId, { tenantId: this.tenantId })
      : null;

    if (durableExecution?.cancellationRequested && context.isActive()) {
      context.requestCancellation(durableExecution.cancellationReason || 'Execution cancellation requested');
    }

    if (durableExecution && ['completed', 'failed', 'cancelled'].includes(durableExecution.status)) {
      if (typeof this.persistence.checkpoints.save === 'function') {
        await this.persistence.checkpoints.save(
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

    if (context.isActive()) context.resume();

    if (!context.isActive()) {
      return {
        resumed: false,
        reason: 'execution_not_resumable',
        execution: context.snapshot()
      };
    }

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

    // Validate the checkpoint before acquiring a lease so malformed durable
    // state cannot strand a resume lease.
    const hasResumeLeaseStore = typeof this.persistence.checkpoints.acquireResumeLease === 'function';
    const resumeLease = hasResumeLeaseStore
      ? await this.persistence.checkpoints.acquireResumeLease(executionId, {
          tenantId: this.tenantId,
          leaseDurationMs: this.resumeLeaseDurationMs
        })
      : null;

    if (hasResumeLeaseStore && !resumeLease) {
      throw Object.assign(new Error('Unable to acquire a durable resume lease'), {
        code: 'CHECKPOINT_RESUME_LEASE_UNAVAILABLE'
      });
    }

    try {
      context.record('execution.resume.started', {
        checkpointId: checkpoint.checkpointId,
        sequence: checkpoint.sequence,
        planRevision
      });

      // A human approval is durable execution state, not request-local input.
      // After a real process restart the caller may not resend the approval;
      // recover the still-valid approval that was issued for this exact
      // execution/step/tool/revision before entering AgentLoop.
      let durableApproval = approval;
      if (!durableApproval && this.approvalService?.findReusable) {
        const pending = context.metadata?.pendingStepInputs || {};
        const pendingSteps = Object.keys(pending)
          .map(Number)
          .filter(Number.isInteger)
          .sort((a, b) => a - b);
        const pendingStep = pendingSteps[0];
        const pendingPlanStep = pendingStep ? plan.steps[pendingStep - 1] : null;
        if (pendingStep && pendingPlanStep?.tool) {
          durableApproval = await this.approvalService.findReusable({
            executionId,
            step: pendingStep,
            tool: pendingPlanStep.tool,
            planRevision,
            tenantId: this.tenantId
          });
          if (durableApproval) {
            context.record('approval.recovered', {
              step: pendingStep,
              planRevision,
              approvalId: durableApproval.approvalId,
              source: 'durable_approval_store'
            });
          }
        }
      }

      const approvalReference = durableApproval?.approvalId
        ? { approvalId: durableApproval.approvalId }
        : null;

      if (resumeLease?.leaseId && typeof this.persistence.checkpoints.renewResumeLease !== 'function') {
        if (typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
          await this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
        }
        throw Object.assign(new Error('Durable resume lease renewal is required for safe execution'), {
          code: 'CHECKPOINT_RESUME_LEASE_RENEWAL_UNSUPPORTED'
        });
      }

      const renewResumeLease = resumeLease?.leaseId
        ? async () => {
            const renewedLease = await this.persistence.checkpoints.renewResumeLease(executionId, resumeLease.leaseId, {
              tenantId: this.tenantId,
              leaseDurationMs: this.resumeLeaseDurationMs
            });
            if (!renewedLease) {
              throw Object.assign(new Error('Execution resume lease was lost before checkpoint commit'), {
                code: 'CHECKPOINT_RESUME_LEASE_LOST'
              });
            }
          }
        : null;
      const heartbeat = renewResumeLease
        ? this.createResumeLeaseHeartbeat(renewResumeLease, Math.max(1, Math.floor(this.resumeLeaseDurationMs / 3)))
        : null;
      let executionResult;
      try {
        executionResult = await this.agentExecutionCoordinator.run({
        context,
        plan,
        validation: { valid: true, steps: plan.steps },
        planRevision,
        replans,
        previousFingerprint: this.planFingerprint(plan),
        approval: approvalReference,
        approvals,
        requestId: context.requestId,
        input: context.input,
        tenantId: this.tenantId,
        agentId: context.metadata?.agentId || 'ORIENT_RUNTIME',
        resumed: true,
        renewResumeLease: heartbeat ? heartbeat.renew : null,
        isCancellationRequested: () => this.isCancellationRequested(context.executionId),
        cancellationReason: context.cancellationReason || 'Execution cancellation requested'
        });
      } finally {
        if (heartbeat) await heartbeat.stop();
      }

      const { loopResult, replanningDecision } = executionResult;
      const activeContextSnapshot = {
        ...context.snapshot(),
        // snapshot() retains the live events array; copy it before the
        // speculative completion mutates the context.
        events: context.events.map(event => ({
          ...event,
          data: { ...(event.data || {}) }
        }))
      };
      context.complete();
      const persistedExecution = await this.persistenceCoordinator.persistExecution(context, 'update');

      // A concurrent durable cancellation must remain authoritative on resume,
      // exactly as it does on first execution. Never report success when the
      // repository rejected the terminal completion write.
      if (persistedExecution?.cancellationRequested || persistedExecution?.status === 'cancelled') {
        const cancellationReason = persistedExecution.cancellationReason || 'Execution cancellation requested';
        context = ExecutionContext.restore(activeContextSnapshot);
        context.requestCancellation(cancellationReason);
        context.cancel(cancellationReason);
        const durableCancellation = await this.persistenceCoordinator.persistExecution(context, 'update');
        await this.persistenceCoordinator.persistEvents(context);
        await this.persistenceCoordinator.checkpoint(context, 'update', 'execution_cancelled');
        if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
          await this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
        }
        return { resumed: false, reason: 'execution_cancelled', execution: durableCancellation || context.snapshot() };
      }

      if (persistedExecution && persistedExecution.status !== context.status) {
        throw Object.assign(new Error('Execution outcome persistence diverged from runtime state'), {
          code: 'EXECUTION_OUTCOME_DIVERGENCE'
        });
      }

      await this.persistenceCoordinator.persistEvents(context);
      await this.persistenceCoordinator.checkpoint(context, 'update', 'execution_completed');
      if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
        await this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
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
      if (error?.code === 'EXECUTION_CANCELLATION_REQUESTED') {
        if (context.isActive()) context.cancel(context.cancellationReason || 'Execution cancelled');
        await this.persistenceCoordinator.checkpoint(context, 'update', 'execution_cancelled');
        await this.persistenceCoordinator.persistEvents(context);
        if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
          await this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
        }
        return { resumed: false, reason: 'execution_cancelled', execution: context.snapshot() };
      }

      const activeSnapshot = this.snapshotActiveContext(context);
      const cancellationBeforeRecovery = await this.reconcileCancellationAfterFailure(
        context,
        executionId,
        activeSnapshot
      );
      if (cancellationBeforeRecovery) {
        if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
          await this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
        }
        return {
          resumed: false,
          reason: 'execution_cancelled',
          execution: cancellationBeforeRecovery.execution
        };
      }

      if (context.status !== 'completed') {
        await this.recoveryCoordinator.fail({
          context,
          error,
          checkpointReason: 'resume_failed'
        });
      }

      const cancellationAfterRecovery = await this.reconcileCancellationAfterFailure(
        context,
        executionId,
        activeSnapshot
      );
      if (cancellationAfterRecovery) {
        if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
          await this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
        }
        return {
          resumed: false,
          reason: 'execution_cancelled',
          execution: cancellationAfterRecovery.execution
        };
      }

      if (resumeLease?.leaseId && typeof this.persistence.checkpoints.releaseResumeLease === 'function') {
        await this.persistence.checkpoints.releaseResumeLease(executionId, resumeLease.leaseId, { tenantId: this.tenantId });
      }
      throw error;
    }
  }
}

module.exports = RequestExecutionCoordinator;
