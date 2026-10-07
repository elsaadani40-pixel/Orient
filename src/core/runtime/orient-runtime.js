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

    this.persistedEventOffsets =
      new WeakMap();

    this.agentLoop =
      new AgentLoop({
        toolRegistry,
        authorizationService,
        idempotencyRepository:
          persistence?.idempotency || null,
        maxToolInputChars,
        agentRegistry: this.agentRegistry
      });

    this.name =
      'ORIENT_RUNTIME';

    this.version =
      '0.9.0';
  }

  persistEvents(context) {
    if (
      !this.persistence ||
      !this.persistence.events
    ) {
      return [];
    }

    const events =
      Array.isArray(context.events)
        ? context.events
        : [];

    if (!events.length) {
      return [];
    }

    const scopedEvents = events.map((event) => ({
      ...event,
      data: {
        ...(event.data || {}),
        tenantId: context.tenantId
      }
    }));

    return this.persistence.events.appendMany(scopedEvents, { tenantId: this.tenantId });
  }

  async persistExecution(context, mode = 'update') {
    if (
      !this.persistence ||
      !this.persistence.executions
    ) {
      return null;
    }

    const snapshot =
      context.snapshot();

    if (snapshot.tenantId && snapshot.tenantId !== this.tenantId) {
      throw Object.assign(new Error('Execution tenant does not match runtime tenant'), { code: 'TENANT_CONTEXT_MISMATCH' });
    }

    if (mode === 'insert') {
      return this.persistence.executions.insert(snapshot, { tenantId: this.tenantId });
    }

    return this.persistence.executions.update(snapshot.executionId, snapshot, { tenantId: this.tenantId });
  }

  async checkpoint(context, mode = 'update', reason = 'runtime_checkpoint') {
    if (!context) {
      throw new TypeError('context is required');
    }

    const snapshot =
      (await this.persistExecution(
        context,
        mode
      )) || context.snapshot();

    const events = Array.isArray(context.events)
      ? context.events
      : [];

    let offset =
      this.persistedEventOffsets.get(context) || 0;

    if (offset > events.length) {
      offset = 0;
    }

    const pendingEvents =
      events.slice(offset).map((event) => ({
        ...event,
        data: {
          ...(event.data || {}),
          tenantId: context.tenantId
        }
      }));

    const persistedEvents =
      pendingEvents.length
        ? this.persistence?.events?.appendMany(pendingEvents, { tenantId: this.tenantId }) || []
        : [];

    this.persistedEventOffsets.set(
      context,
      events.length
    );

    const durableCheckpoint =
      this.persistence?.checkpoints?.save
        ? this.persistence.checkpoints.save(snapshot, { reason, tenantId: this.tenantId })
        : null;

    return {
      snapshot,
      events: persistedEvents?.then ? await persistedEvents : persistedEvents,
      eventCount: (persistedEvents?.then ? (await persistedEvents).length : persistedEvents.length),
      checkpoint: durableCheckpoint?.then ? await durableCheckpoint : durableCheckpoint
    };
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

  async executeWorkflow(input, { approval = null, approvals = {}, priority = 0, deadlineAt = null } = {}) {
    await this.recoveryReady;
    await this.quotaReady;
    const text = String(input || '').trim();

    if (!text) {
      return {
        type: 'error',
        message: 'لم يتم إرسال طلب.'
      };
    }
    if (text.length > this.maxInputChars) {
      return {
        type: 'error',
        code: 'INPUT_TOO_LARGE',
        message: 'حجم الطلب يتجاوز الحد المسموح.'
      };
    }

    this.tenantQuotaService.assertTenant(this.tenantId);
    this.tenantQuotaService.assertInputSize(text);
    if (!this.tenantQuotaRepository) this.tenantQuotaService.assertWorkflowAdmission();

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
    if (this.workflowScheduler.async) {
      await this.workflowScheduler.enqueueDurable(instance, { priority, deadlineAt });
    } else {
      if (this.workflowRepository?.save) this.workflowRepository.save(instance);
      this.workflowScheduler.enqueue(instance, { priority, deadlineAt });
      if (this.workflowRepository?.save) this.workflowRepository.save(instance);
    }

    const WorkerClass = this.workflowScheduler.async ? AsyncWorkflowWorker : WorkflowWorker;
    const worker = new WorkerClass({
      scheduler: this.workflowScheduler,
      eventSink: (event) => {
        if (this.workflowRepository?.save) {
          const persisted = this.workflowRepository.save(instance);
          if (persisted?.then) persisted.catch(() => {});
        }

        if (this.persistence?.events?.append) {
          this.persistence.events.append({
            id: event.eventId || crypto.randomUUID(),
            type: event.type,
            executionId: instance.workflowId,
            timestamp: event.timestamp || new Date().toISOString(),
            data: {
              ...(event.payload || event),
              tenantId: this.tenantId
            }
          });
        }
      },
      executor: async () => this.execute(text, {
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

  async execute(input, { approval = null, approvals = {} } = {}) {
    const requestId =
      crypto.randomUUID();

    const text =
      String(input || '').trim();

    if (!text) {
      return {
        requestId,
        type: 'error',
        message: 'لم يتم إرسال طلب.'
      };
    }
    if (text.length > this.maxInputChars) {
      return {
        requestId,
        type: 'error',
        code: 'INPUT_TOO_LARGE',
        message: 'حجم الطلب يتجاوز الحد المسموح.'
      };
    }

    this.tenantQuotaService.assertTenant(this.tenantId);
    this.tenantQuotaService.assertInputSize(text);

    const context =
      new ExecutionContext({
        requestId,
        input: text,
        tenantId: this.tenantId,
        userId: this.userId,
        workspaceId: this.workspaceId
      });

    context.start();

    context.metadata.tenantQuota =
      this.tenantQuotaPolicy.toJSON();

    context.record(
      'request.understood',
      {
        inputLength:
          text.length
      }
    );

    await this.persistExecution(
      context,
      'insert'
    );

    try {
      context.transitionAgentTo(
        AgentState.LIFECYCLE.PLANNING
      );

      let orchestration =
        await this.agentOrchestrator.plan(
          text,
          context
        );

      let plan =
        orchestration.plan;

      let validation =
        orchestration.validation;

      let planRevision = 1;
      let replans = 0;
      context.metadata.planRevision = planRevision;
      context.metadata.replans = replans;
      let previousFingerprint =
        this.planFingerprint(plan);

      let loopResult = null;
      let replanningDecision = null;

      while (true) {
        context.record(
          'plan.generated',
          {
            intent: plan.intent,
            confidence: plan.confidence,
            planRevision,
            replan: planRevision > 1
          }
        );

        context.transitionAgentTo(
          AgentState.LIFECYCLE.VALIDATING
        );

        context.record(
          'plan.validation.completed',
          {
            valid: validation.valid,
            steps: validation.steps.length,
            planRevision
          }
        );

        context.setPlan(plan);

        context.transitionAgentTo(
          AgentState.LIFECYCLE.EXECUTING
        );

        loopResult =
          await this.agentLoop.run({
            plan,
            context,
            runtimeContext: {
              requestId,
              input: text,
              plan,
              planRevision,
              approval,
              approvals,
              tenantId: this.tenantId,
              agentId: plan.agentId || 'ORIENT_RUNTIME',
              onCheckpoint: async ({ step, planRevision: checkpointPlanRevision, reason = 'step_completed' } = {}) => {
                return this.checkpoint(
                  context,
                  'update',
                  reason + ':plan-' + checkpointPlanRevision + ':step-' + step
                );
              }
            }
          });

        context.transitionAgentTo(
          AgentState.LIFECYCLE.OBSERVING
        );

        context.record(
          'observation.phase.completed',
          {
            stepsExecuted:
              loopResult.stepsExecuted,
            observations:
              context.observations.length,
            planRevision
          }
        );

        context.transitionAgentTo(
          AgentState.LIFECYCLE.EVALUATING
        );

        replanningDecision =
          this.agentOrchestrator.decideReplanning({
            evaluation:
              loopResult.evaluation,
            replans,
            hasRemainingSteps:
              loopResult.stepsExecuted <
              plan.steps.length,
            context
          });

        context.record(
          'replanning.decision',
          {
            ...replanningDecision.toJSON(),
            planRevision,
            replans
          }
        );

        if (
          replanningDecision.nextAction !== 'replan'
        ) {
          break;
        }

        if (replans >= 3) {
          throw Object.assign(
            new Error(
              'تم الوصول إلى الحد الأقصى لإعادة التخطيط'
            ),
            {
              code: 'MAX_REPLANS_EXCEEDED'
            }
          );
        }

        const nextOrchestration =
          await this.agentOrchestrator.replan({
            input: text,
            evaluation: loopResult.evaluation,
            previousPlan: plan,
            context
          });

        if (!nextOrchestration) {
          throw Object.assign(
            new Error(
              'لم يتم إنشاء خطة بديلة صالحة'
            ),
            {
              code: 'REPLAN_NOT_AVAILABLE'
            }
          );
        }

        const nextPlan =
          nextOrchestration.plan;

        const nextValidation =
          nextOrchestration.validation;

        if (
          !nextValidation ||
          nextValidation.valid !== true
        ) {
          throw Object.assign(
            new Error(
              'الخطة الجديدة لم تجتز التحقق'
            ),
            {
              code: 'INVALID_REPLAN_VALIDATION'
            }
          );
        }

        const replanValidation =
          this.validateReplannedPlan(
            nextPlan,
            previousFingerprint
          );

        if (!replanValidation.valid) {
          throw Object.assign(
            new Error(
              replanValidation.reason
            ),
            {
              code: 'INVALID_REPLAN'
            }
          );
        }

        replans += 1;
        planRevision += 1;
        context.metadata.planRevision = planRevision;
        context.metadata.agentId = plan.agentId || context.metadata.agentId || 'ORIENT_RUNTIME';
        context.metadata.replans = replans;
        previousFingerprint =
          replanValidation.fingerprint;

        context.record(
          'replanning.executed',
          {
            replans,
            planRevision,
            previousPlanIntent:
              plan.intent,
            nextPlanIntent:
              nextPlan.intent
          }
        );

        plan = nextPlan;
        validation = nextValidation;

        context.transitionAgentTo(
          AgentState.LIFECYCLE.PLANNING
        );
      }

      context.complete();

      await this.persistExecution(
        context,
        'update'
      );

      await this.persistEvents(
        context
      );

      const result =
        loopResult.result;

      return {
        requestId,

        type:
          this.resolveResponseType(
            plan.intent
          ),

        query:
          plan.intent === 'memory.search'
            ? plan.input
            : '',

        count:
          result &&
          Array.isArray(
            result.memories
          )
            ? result.memories.length
            : undefined,

        result,

        evaluation:
          loopResult.evaluation,

        replanning:
          replanningDecision.toJSON(),

        execution:
          context.snapshot()
      };
    } catch (error) {
      if (
        context.isActive() &&
        context.canTransitionAgentTo(
          AgentState.LIFECYCLE.RECOVERING
        )
      ) {
        context.transitionAgentTo(
          AgentState.LIFECYCLE.RECOVERING
        );
      }

      const recovery =
        await this.classifyRecovery({
          error,
          context
        });

      context.record(
        'recovery.completed',
        recovery
      );

      context.fail(
        error
      );

      this.persistExecution(
        context,
        'update'
      );

      this.persistEvents(
        context
      );

      throw error;
    }
  }

  async resume(executionId, { approval = null, approvals = {} } = {}) {
    if (!this.persistence?.checkpoints?.findLatest) {
      throw Object.assign(
        new Error('Durable checkpoint storage is required for resume'),
        { code: 'CHECKPOINT_STORAGE_REQUIRED' }
      );
    }

    const checkpoint =
      this.persistence.checkpoints.findLatest(executionId, { tenantId: this.tenantId });

    if (!checkpoint) {
      throw Object.assign(
        new Error(`No checkpoint found for execution: ${executionId}`),
        { code: 'CHECKPOINT_NOT_FOUND' }
      );
    }

    const context =
      ExecutionContext.restore(checkpoint.snapshot);

    this.tenantQuotaService.assertTenant(
      context.tenantId || this.tenantId
    );
    this.tenantQuotaService.assertInputSize(context.input);

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
      throw Object.assign(new Error('Checkpoint tenant does not match runtime tenant'), { code: 'TENANT_CONTEXT_MISMATCH' });
    }

    if (!context.isActive()) {
      return {
        resumed: false,
        reason: 'execution_not_resumable',
        execution: context.snapshot()
      };
    }

    let plan =
      context.plan;

    if (!plan || !Array.isArray(plan.steps)) {
      throw Object.assign(
        new Error('Checkpoint does not contain a resumable plan'),
        { code: 'CHECKPOINT_PLAN_REQUIRED' }
      );
    }

    let planRevision =
      Number(context.metadata?.planRevision || 1);

    if (!Number.isInteger(planRevision) || planRevision < 1) {
      throw Object.assign(
        new Error('Checkpoint plan revision is invalid'),
        { code: 'CHECKPOINT_PLAN_REVISION_INVALID' }
      );
    }

    let replans =
      Number(context.metadata?.replans || Math.max(0, planRevision - 1));

    let validation = {
      valid: true,
      steps: plan.steps
    };

    let previousFingerprint =
      this.planFingerprint(plan);

    let loopResult = null;
    let replanningDecision = null;

    try {
      context.record(
        'execution.resume.started',
        {
          checkpointId: checkpoint.checkpointId,
          sequence: checkpoint.sequence,
          planRevision
        }
      );

      while (true) {
        context.setPlan(plan);

        loopResult =
          await this.agentLoop.run({
            plan,
            context,
            runtimeContext: {
              requestId: context.requestId,
              input: context.input,
              plan,
              planRevision,
              approval,
              approvals,
              tenantId: this.tenantId,
              agentId: plan.agentId || context.metadata?.agentId || 'ORIENT_RUNTIME',
              onCheckpoint: async ({ step, planRevision: checkpointPlanRevision, reason = 'resume_step_completed' } = {}) => {
                context.metadata.planRevision = checkpointPlanRevision;
                context.metadata.replans = replans;
                this.checkpoint(
                  context,
                  'update',
                  reason + ':plan-' + checkpointPlanRevision + ':step-' + step
                );
              }
            }
          });

        context.transitionAgentTo(
          AgentState.LIFECYCLE.OBSERVING
        );

        context.transitionAgentTo(
          AgentState.LIFECYCLE.EVALUATING
        );

        replanningDecision =
          this.agentOrchestrator.decideReplanning({
            evaluation: loopResult.evaluation,
            replans,
            hasRemainingSteps:
              loopResult.stepsExecuted < plan.steps.length,
            context
          });

        context.record(
          'replanning.decision',
          {
            ...replanningDecision.toJSON(),
            planRevision,
            replans,
            resumed: true
          }
        );

        if (replanningDecision.nextAction !== 'replan') {
          break;
        }

        if (replans >= 3) {
          throw Object.assign(
            new Error('تم الوصول إلى الحد الأقصى لإعادة التخطيط'),
            { code: 'MAX_REPLANS_EXCEEDED' }
          );
        }

        const nextOrchestration =
          await this.agentOrchestrator.replan({
            input: context.input,
            evaluation: loopResult.evaluation,
            previousPlan: plan,
            context
          });

        if (!nextOrchestration?.plan || nextOrchestration.validation?.valid !== true) {
          throw Object.assign(
            new Error('الخطة المستعادة لم تجتز إعادة التخطيط'),
            { code: 'INVALID_RESUME_REPLAN' }
          );
        }

        const nextPlan =
          nextOrchestration.plan;

        const replanValidation =
          this.validateReplannedPlan(
            nextPlan,
            previousFingerprint
          );

        if (!replanValidation.valid) {
          throw Object.assign(
            new Error(replanValidation.reason),
            { code: 'INVALID_REPLAN' }
          );
        }

        replans += 1;
        planRevision += 1;
        context.metadata.planRevision = planRevision;
        context.metadata.replans = replans;
        previousFingerprint =
          replanValidation.fingerprint;

        plan =
          nextPlan;

        validation =
          nextOrchestration.validation;

        context.record(
          'replanning.executed',
          {
            replans,
            planRevision,
            previousPlanIntent:
              context.plan?.intent || null,
            nextPlanIntent:
              nextPlan.intent,
            resumed: true
          }
        );

        context.transitionAgentTo(
          AgentState.LIFECYCLE.PLANNING
        );
      }

      context.complete();

      await this.persistExecution(context, 'update');
      await this.persistEvents(context);
      await this.checkpoint(context, 'update', 'execution_completed');

      return {
        resumed: true,
        requestId: context.requestId,
        result: loopResult.result,
        evaluation: loopResult.evaluation,
        replanning: replanningDecision.toJSON(),
        execution: context.snapshot()
      };
    } catch (error) {
      if (
        context.isActive() &&
        context.canTransitionAgentTo(
          AgentState.LIFECYCLE.RECOVERING
        )
      ) {
        context.transitionAgentTo(
          AgentState.LIFECYCLE.RECOVERING
        );
      }

      const recovery =
        await this.classifyRecovery({
          error,
          context
        });

      context.record(
        'recovery.completed',
        recovery
      );

      context.fail(error);

      await this.persistExecution(context, 'update');
      await this.persistEvents(context);
      await this.checkpoint(context, 'update', 'resume_failed');

      throw error;
    }
  }

  async classifyRecovery({
    error,
    context
  }) {
    const recovery =
      await this.agentOrchestrator.recover(
        error,
        context
      );

    const serialized =
      typeof recovery?.toJSON ===
      'function'
        ? recovery.toJSON()
        : recovery;

    context.record(
      'recovery.started',
      {
        action:
          serialized.action,

        reason:
          serialized.reason,

        target:
          serialized.target,

        metadata:
          serialized.metadata
      }
    );

    return serialized;
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
