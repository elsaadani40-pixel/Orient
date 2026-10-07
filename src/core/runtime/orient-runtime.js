const crypto = require('crypto');

const ExecutionContext =
  require('../execution/execution-context');

const AgentState =
  require('../agent/state/agent-state');

const AgentLoop =
  require('../execution/agent-loop');

const AgentRegistry =
  require('../agent/boundary/agent-registry');
const { AgentDefinition } =
  require('../agent/boundary/agent-definition');

const ApprovalService =
  require('../agent/approval/approval-service');

const TenantQuotaPolicy =
  require('../security/tenant-quota-policy');
const TenantQuotaService =
  require('../security/tenant-quota-service');

const { WorkflowDefinition, WorkflowInstance, WorkflowScheduler, WorkflowWorker } = require('../workflow');
const AsyncWorkflowScheduler = require('../workflow/async-workflow-scheduler');
const AsyncWorkflowWorker = require('../workflow/async-workflow-worker');
const PostgresTenantQuotaRepository = require('../../infrastructure/persistence/postgres/postgres-tenant-quota-repository');
const ExecutionPersistenceCoordinator = require('./execution-persistence-coordinator');
const WorkflowExecutionCoordinator = require('./workflow-execution-coordinator');
const AgentExecutionCoordinator = require('./agent-execution-coordinator');
const ExecutionRecoveryCoordinator = require('./execution-recovery-coordinator');

class OrientRuntime {
  constructor({
    toolRegistry,
    agentOrchestrator,
    authorizationService = null,
    approvalService = null,
    persistence = null,
    workflowScheduler = null,
    tenantId = 'local',
    userId = 'local',
    workspaceId = 'local',
    maxConcurrent = 1,
    maxQueueDepth = 1000,
    maxRetries = 2,
    leaseDurationMs = 30000,
    maxInputChars = 100000,
    maxToolInputChars = 50000,
    quotaPolicy = null,
    quotaService = null,
    agentRegistry = null,
    agentInvocationService = null,
    capabilityGovernance = null
  }) {
    if (!toolRegistry) {
      throw new TypeError(
        'toolRegistry is required'
      );
    }

    if (!agentOrchestrator) {
      throw new TypeError(
        'agentOrchestrator is required'
      );
    }

    this.toolRegistry =
      toolRegistry;

    this.agentOrchestrator =
      agentOrchestrator;

    this.authorizationService =
      authorizationService;

    if (this.authorizationService && typeof this.toolRegistry.requireAuthorization === 'function') {
      this.toolRegistry.requireAuthorization();
    }

    this.approvalService =
      approvalService ||
      (persistence?.approvals
        ? new ApprovalService({
            repository: persistence.approvals,
            tenantId: tenantId || 'local'
          })
        : null);

    if (this.authorizationService && !this.authorizationService.approvalService) {
      this.authorizationService.approvalService = this.approvalService;
    }

    this.persistence =
      persistence;

    this.tenantId = tenantId || 'local';
    this.userId = userId || 'local';
    this.workspaceId = workspaceId || 'local';
    this.maxInputChars = maxInputChars;

    this.persistenceCoordinator = new ExecutionPersistenceCoordinator({
      persistence,
      tenantId: this.tenantId,
      persistedEventOffsets: new WeakMap()
    });

    this.agentRegistry =
      agentRegistry || new AgentRegistry();

    if (!this.agentRegistry.get('ORIENT_RUNTIME')) {
      this.agentRegistry.register(new AgentDefinition({
        id: 'ORIENT_RUNTIME',
        name: 'ORIENT Canonical Runtime',
        capabilities: ['*'],
        allowedMemoryScopes: ['*'],
        allowedAgentTargets: ['*'],
        risk: 'critical'
      }));
    }

    this.workflowRepository =
      persistence?.workflows || null;

    this.tenantQuotaRepository =
      persistence?.tenantQuotas || (persistence?.isAsync && persistence?.db ? new PostgresTenantQuotaRepository(persistence.db) : null);

    this.workflowScheduler =
      workflowScheduler ||
      (persistence?.isAsync
        ? new AsyncWorkflowScheduler({
            maxConcurrent,
            maxQueueDepth,
            maxRetries,
            leaseDurationMs,
            tenantId: this.tenantId,
            workflowRepository: this.workflowRepository,
            leaseRepository: persistence.workflowLeases,
            quotaRepository: this.tenantQuotaRepository,
            quotaPolicy: this.tenantQuotaPolicy
          })
        : new WorkflowScheduler({
        maxConcurrent,
        maxQueueDepth,
        maxRetries,
        leaseDurationMs,
        tenantId: this.tenantId,
        workflowRepository: this.workflowRepository,
        leaseStore: persistence?.workflowLeases
          ? new (require('../workflow/workflow-lease-store'))({ repository: persistence.workflowLeases, tenantId: this.tenantId })
          : null
      }));

    this.tenantQuotaPolicy =
      quotaPolicy instanceof TenantQuotaPolicy
        ? quotaPolicy
        : new TenantQuotaPolicy({
            maxConcurrent,
            maxQueued: maxQueueDepth,
            maxInputChars,
            maxToolInputChars,
            maxRetries
          });

    if (this.tenantQuotaRepository?.ensureTenant) {
      this.quotaReady = this.tenantQuotaRepository.ensureTenant(this.tenantId, this.tenantQuotaPolicy);
    } else {
      this.quotaReady = Promise.resolve();
    }

    if (this.workflowScheduler?.async) {
      this.workflowScheduler.quotaPolicy = this.tenantQuotaPolicy;
    }

    this.tenantQuotaService =
      quotaService ||
      new TenantQuotaService({
        tenantId: this.tenantId,
        policy: this.tenantQuotaPolicy,
        scheduler: this.workflowScheduler
      });

    if (this.workflowScheduler?.async) {
      this.workflowScheduler.quotaRepository = this.tenantQuotaRepository;
    }

    if (this.tenantQuotaService.scheduler !== this.workflowScheduler) {
      this.tenantQuotaService.scheduler = this.workflowScheduler;
    }

    // Rebuild the in-memory dispatch queue from durable workflow state.
    // Persisted RUNNING workflows are only recovered when their durable lease
    // has expired, preventing two workers from owning the same execution.
    this.recoveryReady = !workflowScheduler && this.workflowRepository?.findAll
      ? Promise.resolve(this.workflowScheduler.recoverPersisted())
      : Promise.resolve(0);

    this.workflowExecutionCoordinator = new WorkflowExecutionCoordinator({
      scheduler: this.workflowScheduler,
      workflowRepository: this.workflowRepository,
      persistence: this.persistence,
      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      executeRequest: (requestInput, options) => this.execute(requestInput, options)
    });

    this.agentLoop =
      new AgentLoop({
        toolRegistry,
        authorizationService,
        idempotencyRepository:
          persistence?.idempotency || null,
        maxToolInputChars,
        agentRegistry: this.agentRegistry
      });

    this.agentExecutionCoordinator = new AgentExecutionCoordinator({
      agentOrchestrator: this.agentOrchestrator,
      agentLoop: this.agentLoop,
      checkpoint: (context, mode, reason) => this.checkpoint(context, mode, reason),
      validateReplannedPlan: (nextPlan, previousFingerprint) => this.validateReplannedPlan(nextPlan, previousFingerprint)
    });

    this.executionRecoveryCoordinator = new ExecutionRecoveryCoordinator({
      agentOrchestrator: this.agentOrchestrator,
      persistExecution: (context, mode) => this.persistExecution(context, mode),
      persistEvents: (context) => this.persistEvents(context),
      checkpoint: (context, mode, reason) => this.checkpoint(context, mode, reason)
    });

    this.name =
      'ORIENT_RUNTIME';

    this.version =
      '0.9.0';
  }

  persistEvents(context) {
    return this.persistenceCoordinator.persistEvents(context);
  }

  async persistExecution(context, mode = 'update') {
    return this.persistenceCoordinator.persistExecution(context, mode);
  }

  async checkpoint(context, mode = 'update', reason = 'runtime_checkpoint') {
    return this.persistenceCoordinator.checkpoint(context, mode, reason);
  }

  planFingerprint(plan) {
    if (!plan || typeof plan !== 'object') {
      return null;
    }

    const normalized = {
      intent: plan.intent || null,
      agentId: plan.agentId || null,
      input: plan.input ?? null,
      steps: Array.isArray(plan.steps)
        ? plan.steps.map((step) => ({
            step: step.step || null,
            tool: step.tool || null,
            input: step.input ?? null,
            dependsOn:
              step.dependsOn ?? null
          }))
        : []
    };

    return JSON.stringify(normalized);
  }

  validateReplannedPlan(plan, previousFingerprint) {
    if (!plan || typeof plan !== 'object') {
      return {
        valid: false,
        reason: 'لم يتم إنشاء خطة جديدة'
      };
    }

    const fingerprint =
      this.planFingerprint(plan);

    if (!fingerprint) {
      return {
        valid: false,
        reason: 'تعذر إنشاء هوية للخطة الجديدة'
      };
    }

    if (
      previousFingerprint &&
      fingerprint === previousFingerprint
    ) {
      return {
        valid: false,
        reason: 'الخطة الجديدة مطابقة للخطة السابقة'
      };
    }

    return {
      valid: true,
      fingerprint
    };
  }

  shutdown(options = {}) {
    return this.workflowScheduler?.shutdown
      ? this.workflowScheduler.shutdown(options)
      : null;
  }

  async executeWorkflow(input, options = {}) {
    return this.workflowExecutionCoordinator.execute(input, options);
  }

  async execute(input, { approval = null, approvals = {} } = {}) {
    const requestId = crypto.randomUUID();
    const text = String(input || '').trim();
    if (!text) return { requestId, type: 'error', message: 'لم يتم إرسال طلب.' };
    if (text.length > this.maxInputChars) return { requestId, type: 'error', code: 'INPUT_TOO_LARGE', message: 'حجم الطلب يتجاوز الحد المسموح.' };

    this.tenantQuotaService.assertTenant(this.tenantId);
    this.tenantQuotaService.assertInputSize(text);

    const context = new ExecutionContext({
      requestId, input: text, tenantId: this.tenantId, userId: this.userId, workspaceId: this.workspaceId
    });
    context.start();
    context.metadata.tenantQuota = this.tenantQuotaPolicy.toJSON();
    context.record('request.understood', { inputLength: text.length });
    await this.persistExecution(context, 'insert');

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
        approval, approvals, requestId, input: text, tenantId: this.tenantId
      });

      const plan = executionResult.plan;
      const loopResult = executionResult.loopResult;
      const replanningDecision = executionResult.replanningDecision;

      context.complete();
      await this.persistExecution(context, 'update');
      await this.persistEvents(context);

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
      await this.executionRecoveryCoordinator.fail({ context, error });
      throw error;
    }
  }

  async resume(executionId, { approval = null, approvals = {} } = {}) {
    if (!this.persistence?.checkpoints?.findLatest) throw Object.assign(new Error('Durable checkpoint storage is required for resume'), { code: 'CHECKPOINT_STORAGE_REQUIRED' });

    const checkpoint = this.persistence.checkpoints.findLatest(executionId, { tenantId: this.tenantId });
    if (!checkpoint) throw Object.assign(new Error(`No checkpoint found for execution: ${executionId}`), { code: 'CHECKPOINT_NOT_FOUND' });

    const context = ExecutionContext.restore(checkpoint.snapshot);
    this.tenantQuotaService.assertTenant(context.tenantId || this.tenantId);
    this.tenantQuotaService.assertInputSize(context.input);

    if (!context.tenantId) context.tenantId = this.tenantId;
    if (!context.userId) context.userId = this.userId;
    if (!context.workspaceId) context.workspaceId = this.workspaceId;
    context.metadata = { ...context.metadata, tenantId: context.tenantId, userId: context.userId, workspaceId: context.workspaceId };

    if (context.tenantId !== this.tenantId) throw Object.assign(new Error('Checkpoint tenant does not match runtime tenant'), { code: 'TENANT_CONTEXT_MISMATCH' });
    if (!context.isActive()) return { resumed: false, reason: 'execution_not_resumable', execution: context.snapshot() };

    const plan = context.plan;
    if (!plan || !Array.isArray(plan.steps)) throw Object.assign(new Error('Checkpoint does not contain a resumable plan'), { code: 'CHECKPOINT_PLAN_REQUIRED' });

    const planRevision = Number(context.metadata?.planRevision || 1);
    if (!Number.isInteger(planRevision) || planRevision < 1) throw Object.assign(new Error('Checkpoint plan revision is invalid'), { code: 'CHECKPOINT_PLAN_REVISION_INVALID' });
    const replans = Number(context.metadata?.replans || Math.max(0, planRevision - 1));

    try {
      context.record('execution.resume.started', { checkpointId: checkpoint.checkpointId, sequence: checkpoint.sequence, planRevision });
      const executionResult = await this.agentExecutionCoordinator.run({
        context,
        plan,
        validation: { valid: true, steps: plan.steps },
        planRevision,
        replans,
        previousFingerprint: this.planFingerprint(plan),
        approval, approvals,
        requestId: context.requestId,
        input: context.input,
        tenantId: this.tenantId,
        agentId: context.metadata?.agentId || 'ORIENT_RUNTIME',
        resumed: true
      });

      const loopResult = executionResult.loopResult;
      const replanningDecision = executionResult.replanningDecision;
      context.complete();
      await this.persistExecution(context, 'update');
      await this.persistEvents(context);
      await this.checkpoint(context, 'update', 'execution_completed');

      return { resumed: true, requestId: context.requestId, result: loopResult.result, evaluation: loopResult.evaluation, replanning: replanningDecision.toJSON(), execution: context.snapshot() };
    } catch (error) {
      await this.executionRecoveryCoordinator.fail({
        context,
        error,
        checkpointReason: 'resume_failed'
      });
      throw error;
    }
  }

  resolveResponseType(intent) {
    if (
      typeof intent === 'string' &&
      intent.startsWith('memory.')
    ) {
      return 'memory_result';
    }

    return 'tool_result';
  }
}

module.exports =
  OrientRuntime;
