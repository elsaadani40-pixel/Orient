const crypto = require('crypto');

const ExecutionContext =
  require('../execution/execution-context');

const AgentState =
  require('../agent/state/agent-state');

const AgentLoop =
  require('../execution/agent-loop');

const ApprovalService =
  require('../agent/approval/approval-service');

class OrientRuntime {
  constructor({
    toolRegistry,
    agentOrchestrator,
    authorizationService = null,
    approvalService = null,
    persistence = null
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

    this.approvalService =
      approvalService ||
      (persistence?.approvals
        ? new ApprovalService({
            repository: persistence.approvals
          })
        : null);

    if (this.authorizationService && !this.authorizationService.approvalService) {
      this.authorizationService.approvalService = this.approvalService;
    }

    this.persistence =
      persistence;

    this.persistedEventOffsets =
      new WeakMap();

    this.agentLoop =
      new AgentLoop({
        toolRegistry,
        authorizationService,
        idempotencyRepository:
          persistence?.idempotency || null
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

    return this.persistence.events.appendMany(
      events
    );
  }

  persistExecution(context, mode = 'update') {
    if (
      !this.persistence ||
      !this.persistence.executions
    ) {
      return null;
    }

    const snapshot =
      context.snapshot();

    if (mode === 'insert') {
      return this.persistence.executions.insert(
        snapshot
      );
    }

    return this.persistence.executions.update(
      snapshot.executionId,
      snapshot
    );
  }

  checkpoint(context, mode = 'update', reason = 'runtime_checkpoint') {
    if (!context) {
      throw new TypeError('context is required');
    }

    const snapshot =
      this.persistExecution(
        context,
        mode
      ) || context.snapshot();

    const events = Array.isArray(context.events)
      ? context.events
      : [];

    let offset =
      this.persistedEventOffsets.get(context) || 0;

    if (offset > events.length) {
      offset = 0;
    }

    const pendingEvents =
      events.slice(offset);

    const persistedEvents =
      pendingEvents.length
        ? this.persistence?.events?.appendMany(
            pendingEvents
          ) || []
        : [];

    this.persistedEventOffsets.set(
      context,
      events.length
    );

    const durableCheckpoint =
      this.persistence?.checkpoints?.save
        ? this.persistence.checkpoints.save(snapshot, { reason })
        : null;

    return {
      snapshot,
      events: persistedEvents,
      eventCount: persistedEvents.length,
      checkpoint: durableCheckpoint
    };
  }

  planFingerprint(plan) {
    if (!plan || typeof plan !== 'object') {
      return null;
    }

    const normalized = {
      intent: plan.intent || null,
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

    const context =
      new ExecutionContext({
        requestId,
        input: text
      });

    context.start();

    context.record(
      'request.understood',
      {
        inputLength:
          text.length
      }
    );

    this.persistExecution(
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
              onCheckpoint: async ({ step, planRevision: checkpointPlanRevision, reason = 'step_completed' } = {}) => {
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

      this.persistExecution(
        context,
        'update'
      );

      this.persistEvents(
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
      this.persistence.checkpoints.findLatest(executionId);

    if (!checkpoint) {
      throw Object.assign(
        new Error(`No checkpoint found for execution: ${executionId}`),
        { code: 'CHECKPOINT_NOT_FOUND' }
      );
    }

    const context =
      ExecutionContext.restore(checkpoint.snapshot);

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

      this.persistExecution(context, 'update');
      this.persistEvents(context);
      this.checkpoint(context, 'update', 'execution_completed');

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

      this.persistExecution(context, 'update');
      this.persistEvents(context);
      this.checkpoint(context, 'update', 'resume_failed');

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
