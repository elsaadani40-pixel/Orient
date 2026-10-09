const crypto = require('crypto');
const { performance } = require('perf_hooks');

const AppError = require('../errors/AppError');

const EvaluationEngine =
  require('../agent/evaluation/evaluation-engine');

const ResultReferenceResolver =
  require('./result-reference-resolver');

const RetryPolicy =
  require('./policy/retry-policy');

const RetryExecutor =
  require('./retry/retry-executor');

const IdempotencyStore =
  require('./idempotency/idempotency-store');

const { createToolExecutionAuthorizer } =
  require('../tools/tool-execution-authorization');


class AgentLoop {
  constructor({
    toolRegistry,
    authorizationService = null,
    idempotencyRepository = null,
    maxToolInputChars = 50000,
    maxSteps = 5,
    maxExecutionMs = 300000,
    clock = () => performance.now(),
    agentRegistry = null,
    agentInvocationService = null,
    capabilityGovernance = null,
    evaluationEngine = null
  }) {
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }

    this.toolRegistry = toolRegistry;
    this.executionAuthorizer = createToolExecutionAuthorizer();

    // Once an AuthorizationService is present, every tool execution must carry
    // the non-forgeable authorization binding. Recovery/reconciliation paths are
    // deliberately subject to the same registry boundary and cannot fall back to
    // an unauthenticated direct tool call.
    if (authorizationService && typeof this.toolRegistry.requireAuthorization === 'function') {
      this.toolRegistry.requireAuthorization();
    }
    this.authorizationService =
      authorizationService;

    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new TypeError('maxSteps must be a positive integer');
    }

    if (!Number.isInteger(maxExecutionMs) || maxExecutionMs < 1) {
      throw new TypeError('maxExecutionMs must be a positive integer');
    }

    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function');
    }

    this.maxToolInputChars = maxToolInputChars;
    this.maxSteps = maxSteps;
    this.maxExecutionMs = maxExecutionMs;
    this.clock = clock;
    this.agentRegistry = agentRegistry;
    this.agentInvocationService = agentInvocationService;
    this.capabilityGovernance = capabilityGovernance;
    this.evaluationEngine =
      evaluationEngine || new EvaluationEngine();

    this.name = 'ORIENT_AGENT_LOOP';
    this.version = '0.8.2';

    this.resultReferenceResolver =
      new ResultReferenceResolver();

    this.retryPolicy =
      new RetryPolicy({
        maxAttempts: 2
      });

    this.retryExecutor =
      new RetryExecutor({
        policy: this.retryPolicy
      });

    this.idempotencyStore =
      new IdempotencyStore({ repository: idempotencyRepository });
  }

  async run({
    plan,
    context,
    runtimeContext = {}
  }) {
    if (!plan) {
      throw new AppError(
        'خطة التنفيذ مطلوبة',
        500,
        'PLAN_REQUIRED'
      );
    }

    if (!context) {
      throw new AppError(
        'Execution Context مطلوب',
        500,
        'EXECUTION_CONTEXT_REQUIRED'
      );
    }

    const planRevision =
      Number(runtimeContext.planRevision || 1);

    const executionStartedAt = this.clock();

    if (!Number.isInteger(planRevision) || planRevision < 1) {
      throw new AppError(
        'إصدار الخطة غير صالح',
        500,
        'INVALID_PLAN_REVISION'
      );
    }

    const steps = this.normalizeSteps(plan);

    if (steps.length === 0) {
      const evaluation = this.evaluate({
        plan,
        step: null,
        result: null,
        stepNumber: 0
      });

      context.record(
        'evaluation.completed',
        evaluation
      );

      return {
        status: evaluation.outcome,
        result: null,
        evaluation,
        stepsExecuted: 0,
        stepResults: []
      };
    }

    this.validateDependencies(steps);

    const completedSteps = new Set();
    const stepResults = [];

    let lastResult = null;
    let lastEvaluation = null;

    this.restoreLoopState({
      steps,
      context,
      completedSteps,
      stepResults,
      planRevision
    });

    if (stepResults.length > 0) {
      const lastStepResult =
        stepResults[stepResults.length - 1];

      lastResult =
        lastStepResult.result;
    }

    const throwIfCancellationRequested = async () => {
      if (typeof runtimeContext.isCancellationRequested === 'function' && await runtimeContext.isCancellationRequested()) {
        const reason = runtimeContext.cancellationReason || 'Execution cancellation requested';
        context.requestCancellation(reason);
        context.record('execution.cancellation.observed', { reason, currentStep: context.currentStep });
        throw new AppError('Execution cancellation requested', 409, 'EXECUTION_CANCELLATION_REQUESTED');
      }
    };

    for (
      let index = 0;
      index < steps.length;
      index += 1
    ) {
      const stepNumber = index + 1;
      const step = steps[index];

      await throwIfCancellationRequested();

      if (completedSteps.has(stepNumber)) {
        context.record(
          'execution.step.resumed',
          {
            step: stepNumber,
            tool: step.tool,
            reason: 'step_already_completed'
          }
        );

        continue;
      }

      const elapsedMs = this.clock() - executionStartedAt;

      if (elapsedMs >= this.maxExecutionMs) {
        const error = new AppError(
          'تم تجاوز الحد الأقصى لزمن تنفيذ المهمة',
          408,
          'MAX_EXECUTION_TIME_EXCEEDED'
        );

        context.record(
          'execution.stopped',
          {
            reason: 'max_execution_time',
            maxExecutionMs: this.maxExecutionMs,
            elapsedMs
          }
        );

        throw error;
      }

      if (stepNumber > this.maxSteps) {
        const error = new AppError(
          'تم تجاوز الحد الأقصى لخطوات التنفيذ',
          500,
          'MAX_EXECUTION_STEPS_EXCEEDED'
        );

        context.record(
          'execution.stopped',
          {
            reason: 'max_steps',
            maxSteps: this.maxSteps
          }
        );

        throw error;
      }

      this.enforceDependency({
        step,
        stepNumber,
        completedSteps,
        context
      });

      const agentAuthorization = this.authorizeAgentStep({
        step,
        stepNumber,
        plan,
        runtimeContext,
        context
      });

      let agentInvocation = null;

      if (step.targetAgentId) {
        if (!this.agentInvocationService) {
          throw new AppError(
            'Agent invocation service is required for delegated steps',
            500,
            'AGENT_INVOCATION_SERVICE_REQUIRED'
          );
        }

        try {
          agentInvocation =
            this.agentInvocationService.authorize({
              sourceAgentId: agentAuthorization.agentId,
              targetAgentId: step.targetAgentId,
              capability: step.targetCapability || null,
              reason: step.invocationReason || null
            });

          context.record(
            'agent.invocation.authorized',
            agentInvocation
          );
        } catch (error) {
          context.record(
            'agent.invocation.denied',
            {
              sourceAgentId: agentAuthorization.agentId,
              targetAgentId: step.targetAgentId,
              capability: step.targetCapability || null,
              code: error.code || 'AGENT_TARGET_FORBIDDEN',
              reason: error.message
            }
          );

          throw error;
        }
      }

      if (this.capabilityGovernance) {
        try {
          const governance = this.capabilityGovernance.authorizeTool({
            agentId: agentAuthorization?.agentId || 'ORIENT_RUNTIME',
            tool: step.tool
          });

          context.record('capability.governance.authorized', {
            step: stepNumber,
            agentId: governance.agentId,
            tool: governance.tool,
            capability: governance.capability,
            risk: governance.risk
          });
        } catch (error) {
          context.record('capability.governance.denied', {
            step: stepNumber,
            agentId: agentAuthorization?.agentId || 'ORIENT_RUNTIME',
            tool: step.tool,
            code: error.code || 'CAPABILITY_GOVERNANCE_DENIED',
            reason: error.message
          });
          throw error;
        }
      }

      if (!step.tool) {
        context.record(
          'execution.step.skipped',
          {
            step: stepNumber,
            reason: 'لا توجد أداة'
          }
        );

        continue;
      }

      if (!this.toolRegistry.has(step.tool)) {
        const error = new AppError(
          `الأداة "${step.tool}" غير مسجلة`,
          500,
          'TOOL_NOT_REGISTERED'
        );

        context.record(
          'authorization.failed',
          {
            step: stepNumber,
            tool: step.tool,
            reason: 'tool_not_registered'
          }
        );

        throw error;
      }

      const resolvedInput =
        this.resolveStepInput({
          step,
          stepNumber,
          context,
          stepResults,
          lastResult
        });

      const resolvedInputSize =
        typeof resolvedInput === 'string'
          ? resolvedInput.length
          : JSON.stringify(resolvedInput ?? null).length;

      if (resolvedInputSize > this.maxToolInputChars) {
        throw new AppError(
          'حجم مدخلات الأداة يتجاوز الحد المسموح',
          413,
          'TOOL_INPUT_TOO_LARGE'
        );
      }

      const operationTenantId = runtimeContext.tenantId || context.tenantId || 'local';
      const operationId = crypto
        .createHash('sha256')
        .update(JSON.stringify({
          tenantId: operationTenantId,
          executionId: context.executionId,
          planRevision,
          step: stepNumber,
          tool: step.tool,
          input: resolvedInput
        }))
        .digest('hex');
      const recoveringPersistedOperation =
        Array.isArray(context.steps) &&
        context.steps.some(
          (persistedStep) =>
            persistedStep &&
            persistedStep.status === 'running' &&
            Number(persistedStep.planRevision || 1) === planRevision &&
            persistedStep.step === stepNumber &&
            persistedStep.tool === step.tool
        );

      let executionAuthorization = null;

      if (this.authorizationService && !recoveringPersistedOperation) {
        await throwIfCancellationRequested();
        let authorization;

        try {
          const approval =
            runtimeContext.approvals?.[stepNumber] ||
            runtimeContext.approval ||
            null;

          authorization =
            await this.authorizationService
              .assertAuthorized(step.tool, {
                executionId: context.executionId,
                step: stepNumber,
                planRevision,
                approval,
                agentId: agentAuthorization?.agentId || runtimeContext.agentId || plan.agentId || 'ORIENT_RUNTIME',
                tenantId: runtimeContext.tenantId || context.tenantId,
                operationId,
                scope: { planRevision }
              });

          context.record(
            'authorization.completed',
            {
              step: stepNumber,
              tool: step.tool,
              authorized: true,
              capability:
                authorization.capability,
              risk:
                authorization.risk,
              requiresApproval:
                authorization.requiresApproval
            }
          )
          executionAuthorization = authorization;;
        } catch (error) {
          context.record(
            'authorization.failed',
            {
              step: stepNumber,
              tool: step.tool,
              code:
                error.code ||
                'TOOL_NOT_AUTHORIZED',
              reason: error.message
            }
          );

          if (error.code === 'APPROVAL_REQUIRED') {
            error.executionContext = {
              executionId: context.executionId,
              step: stepNumber,
              planRevision,
              operationId,
              tool: step.tool,
              capability: error.capability || agentAuthorization?.capability || null,
              agentId: agentAuthorization?.agentId || runtimeContext.agentId || plan.agentId || 'ORIENT_RUNTIME',
              tenantId: runtimeContext.tenantId || context.tenantId
            };
          }

          throw error;
        }

        if (
          authorization.requiresApproval &&
          authorization.approval &&
          this.authorizationService.approvalService
        ) {
          const consumed =
            await this.authorizationService.approvalService.consume(
              authorization.approval.approvalId,
              runtimeContext.tenantId || context.tenantId
            );

          if (!consumed) {
            throw new AppError(
              'Approval could not be consumed safely',
              409,
              'APPROVAL_CONSUME_FAILED'
            );
          }

          context.record(
            'approval.consumed',
            {
              step: stepNumber,
              tool: step.tool,
              approvalId:
                authorization.approval.approvalId,
              planRevision
            }
          );
        }
      } else if (!this.authorizationService) {
        context.record(
          'authorization.completed',
          {
            step: stepNumber,
            tool: step.tool,
            authorized: true,
            mode: 'legacy'
          }
        );
      } else {
        context.record(
          'authorization.reused',
          {
            step: stepNumber,
            tool: step.tool,
            planRevision,
            reason: 'persisted_operation_recovery'
          }
        );
      }

      const injectedContext =
        this.buildStepContext({
          plan,
          context,
          runtimeContext,
          step,
          stepNumber,
          previousResult: lastResult,
          stepResults
        });

      if (agentAuthorization) {
        injectedContext.agentId = agentAuthorization.agentId;
        injectedContext.capability = agentAuthorization.capability;
        injectedContext.memoryScope = step.memoryScope || runtimeContext.memoryScope || 'personal';
      }

      if (agentInvocation) {
        injectedContext.agentInvocation = agentInvocation;
      }

      injectedContext.resolvedInput =
        resolvedInput;

      injectedContext.planRevision = planRevision;
      // Carry the canonical tenant identity into every tool adapter context.
      injectedContext.tenantId = operationTenantId;
      // Expose the durable logical operation identity to tool adapters so they
      // can forward it as a provider idempotency key. The value is stable across
      // retries/resume for the same execution, plan revision, step, tool, input.
      injectedContext.operationId = operationId;
      injectedContext.idempotencyKey = crypto
        .createHash('sha256')
        .update(JSON.stringify({
          tenantId: runtimeContext.tenantId || context.tenantId || 'local',
          operationId
        }))
        .digest('hex');

      if (executionAuthorization) {
        const binding = {
          tool: step.tool,
          agentId: injectedContext.agentId || runtimeContext.agentId || plan.agentId || 'ORIENT_RUNTIME',
          executionId: context.executionId,
          step: stepNumber,
          planRevision
        };

        if (typeof this.toolRegistry.authorizeExecutionContext === 'function') {
          this.toolRegistry.authorizeExecutionContext(
            injectedContext,
            executionAuthorization,
            binding
          );
        } else {
          this.executionAuthorizer.authorizeContext(
            injectedContext,
            executionAuthorization,
            binding
          );
        }
      }

      context.record(
        'context.injected',
        {
          step: stepNumber,
          tool: step.tool,
          previousSteps: stepResults.length,
          dependsOn: step.dependsOn
        }
      );

      context.record(
        'result.references.resolved',
        {
          step: stepNumber,
          tool: step.tool
        }
      );

      context.setTool(step.tool);

      context.startStep({
        step: stepNumber,
        tool: step.tool,
        planRevision,
        operationId
      });

      const idempotency =
        this.idempotencyStore.begin({
          executionId:
            context.executionId,
          step: stepNumber,
          tool: step.tool,
          planRevision,
          operationId,
          // Persist the same canonical tenant identity used by operationId and cleanup.
          tenantId: operationTenantId
        });

      context.record(
        'idempotency.checked',
        {
          step: stepNumber,
          tool: step.tool,
          key: idempotency.key,
          operationId,
          planRevision,
          created: idempotency.created
        }
      );

      if (idempotency.created && typeof runtimeContext.onCheckpoint === 'function') {
        try {
          await runtimeContext.onCheckpoint({
            step: stepNumber,
            planRevision,
            reason: 'step_started'
          });

          // We are still before the tool boundary, so cancellation can safely
          // release the reservation instead of leaving a never-started operation
          // looking like an ambiguous external side effect.
          await throwIfCancellationRequested();
        } catch (error) {
          try {
            await this.idempotencyStore.delete(
              idempotency.key,
              operationTenantId
            );
          } catch (cleanupError) {
            error.idempotencyCleanupError = cleanupError;
          }
          throw error;
        }
      }

      if (!idempotency.created) {
        const existing =
          idempotency.record;

        if (
          existing.status === 'completed'
        ) {
          context.record(
            'idempotency.reused',
            {
              step: stepNumber,
              tool: step.tool,
              key: idempotency.key
            }
          );

          context.completeStep({
            step: stepNumber,
            tool: step.tool,
            result: existing.result,
            planRevision
          });

          context.addObservation({
            step: stepNumber,
            tool: step.tool,
            success: true,
            result: existing.result
          });

          completedSteps.add(
            stepNumber
          );

          const stepRecord = {
            step: stepNumber,
            tool: step.tool,
            input: resolvedInput,
            originalInput: step.input,
            dependsOn: step.dependsOn,
            result: existing.result,
            success: true,
            idempotencyReused: true,
            completedAt:
              existing.completedAt
          };

          stepResults.push(
            stepRecord
          );

          const evaluation =
            this.evaluate({
              plan,
              step,
              result: existing.result,
              stepNumber
            });

          context.record(
            'evaluation.completed',
            {
              ...evaluation,
              step: stepNumber,
              tool: step.tool,
              idempotencyReused: true
            }
          );

          lastResult =
            existing.result;

          lastEvaluation =
            evaluation;

          if (
            evaluation.outcome === 'done' &&
            index === steps.length - 1
          ) {
            return {
              status: 'done',
              result: existing.result,
              evaluation,
              stepsExecuted: stepNumber,
              stepResults
            };
          }

          continue;
        }

        if (
          existing.status === 'running' ||
          existing.status === 'unknown'
        ) {
          // A persisted RUNNING operation is not proof that the external side effect
          // did not happen. After a crash, retrying blindly can duplicate irreversible
          // work. Reconciliation must therefore be explicit and authoritative.
          let reconciliation = null;

          const toolDefinitionForRecovery =
            this.toolRegistry.get(step.tool);

          if (typeof runtimeContext.reconcileOperation === 'function') {
            reconciliation = await runtimeContext.reconcileOperation({
              operationId,
              executionId: context.executionId,
              step: stepNumber,
              planRevision,
              tool: step.tool,
              input: resolvedInput,
              record: existing
            });
          } else if (typeof toolDefinitionForRecovery?.reconcile === 'function') {
            reconciliation = await toolDefinitionForRecovery.reconcile(
              resolvedInput,
              {
                operationId,
                executionId: context.executionId,
                step: stepNumber,
                planRevision,
                tool: step.tool,
                record: existing,
                context
              }
            );
          }

          if (reconciliation?.status === 'conflict') {
            const error = new AppError(
              `العملية "${operationId}" اصطدمت بتغيير خارجي بعد التعطل ولا يمكن استئنافها تلقائيًا`,
              409,
              'IDEMPOTENCY_RECONCILIATION_CONFLICT'
            );

            context.record('idempotency.reconciliation_conflict', {
              step: stepNumber,
              tool: step.tool,
              key: idempotency.key,
              operationId,
              reason: reconciliation.reason || 'external_state_conflict'
            });

            throw error;
          }

          if (reconciliation?.status === 'completed') {
            const reconciledResult = reconciliation.result;
            this.idempotencyStore.complete(
              idempotency.key,
              reconciledResult,
              operationTenantId
            );

            context.record('idempotency.reconciled', {
              step: stepNumber,
              tool: step.tool,
              key: idempotency.key,
              operationId,
              outcome: 'completed'
            });

            context.completeStep({
              step: stepNumber,
              tool: step.tool,
              result: reconciledResult,
              planRevision
            });
            context.addObservation({
              step: stepNumber,
              tool: step.tool,
              success: true,
              result: reconciledResult
            });
            completedSteps.add(stepNumber);
            stepResults.push({
              step: stepNumber,
              planRevision,
              operationId,
              tool: step.tool,
              input: resolvedInput,
              originalInput: step.input,
              dependsOn: step.dependsOn,
              result: reconciledResult,
              success: true,
              reconciled: true,
              completedAt: new Date().toISOString()
            });
            lastResult = reconciledResult;
            lastEvaluation = this.evaluate({
              plan,
              step,
              result: reconciledResult,
              stepNumber
            });
            context.record('evaluation.completed', {
              ...lastEvaluation,
              step: stepNumber,
              tool: step.tool,
              reconciled: true
            });
            continue;
          }

          const error = new AppError(
            `لا يمكن استئناف العملية "${operationId}" بأمان قبل التحقق من حالتها الخارجية`,
            409,
            'IDEMPOTENCY_OPERATION_UNKNOWN'
          );

          context.record('idempotency.reconciliation_required', {
            step: stepNumber,
            tool: step.tool,
            key: idempotency.key,
            operationId,
            status: existing.status
          });

          throw error;
        }

        const error = new AppError(
          `لا يمكن إعادة تنفيذ الأداة "${step.tool}" بسبب سجل Idempotency سابق`,
          409,
          'IDEMPOTENCY_REPLAY_REJECTED'
        );

        context.record(
          'idempotency.rejected',
          {
            step: stepNumber,
            tool: step.tool,
            key: idempotency.key,
            status: existing.status
          }
        );

        throw error;
      }

      try {
        await throwIfCancellationRequested();
      } catch (error) {
        // This is the last cancellation gate before tool invocation. If this
        // operation was reserved in this attempt, no side effect has started.
        if (idempotency.created) {
          try {
            await this.idempotencyStore.delete(
              idempotency.key,
              operationTenantId
            );
          } catch (cleanupError) {
            error.idempotencyCleanupError = cleanupError;
          }
        }
        throw error;
      }

      const toolDefinition =
        this.toolRegistry.get(
          step.tool
        );

      let idempotencyCompleted = false;

      try {
        const execution =
          await this.retryExecutor.execute({
            tool: toolDefinition,
            step: stepNumber,
            context,
            execute: async () =>
              this.toolRegistry.execute(
                step.tool,
                resolvedInput,
                injectedContext
              )
          });

        const result =
          execution.result;

        this.idempotencyStore.complete(
          idempotency.key,
          result,
          operationTenantId
        );
        idempotencyCompleted = true;

        context.record(
          'idempotency.completed',
          {
            step: stepNumber,
            tool: step.tool,
            key: idempotency.key
          }
        );

        context.completeStep({
          step: stepNumber,
          tool: step.tool,
          result,
          planRevision
        });

        context.addObservation({
          step: stepNumber,
          tool: step.tool,
          success: true,
          result
        });

        completedSteps.add(stepNumber);

        const stepRecord = {
          step: stepNumber,
          planRevision,
          operationId,
          tool: step.tool,
          input: resolvedInput,
          originalInput: step.input,
          dependsOn: step.dependsOn,
          result,
          success: true,
          completedAt:
            new Date().toISOString()
        };

        stepResults.push(stepRecord);

        const evaluation =
          this.evaluate({
            plan,
            step,
            result,
            stepNumber
          });

        context.record(
          'evaluation.completed',
          {
            ...evaluation,
            step: stepNumber,
            tool: step.tool
          }
        );

        if (typeof runtimeContext.onCheckpoint === 'function') {
          await runtimeContext.onCheckpoint({
            step: stepNumber,
            planRevision,
            reason: evaluation.outcome === 'replan' ? 'replan_requested' : 'step_completed'
          });
        }

        lastResult = result;
        lastEvaluation = evaluation;

        if (
          evaluation.outcome === 'failed'
        ) {
          return {
            status: 'failed',
            result,
            evaluation,
            stepsExecuted: stepNumber,
            stepResults
          };
        }

        if (
          evaluation.outcome === 'done' &&
          index === steps.length - 1
        ) {
          return {
            status: 'done',
            result,
            evaluation,
            stepsExecuted: stepNumber,
            stepResults
          };
        }
      } catch (error) {
        // Once the idempotency record is completed, the external side effect is
        // considered committed. A later failure (for example, checkpoint
        // persistence) must not downgrade that operation to failed, because
        // doing so would make a retry eligible to execute the side effect twice.
        if (idempotencyCompleted) {
          throw error;
        }

        this.idempotencyStore.fail(
          idempotency.key,
          error,
          operationTenantId
        );

        context.record(
          'idempotency.failed',
          {
            step: stepNumber,
            tool: step.tool,
            key: idempotency.key,
            code:
              error.code ||
              'TOOL_EXECUTION_FAILED'
          }
        );

        context.failStep({
          step: stepNumber,
          tool: step.tool,
          error,
          planRevision
        });

        context.addObservation({
          step: stepNumber,
          tool: step.tool,
          success: false,
          error: {
            code:
              error.code ||
              'TOOL_EXECUTION_FAILED',
            message: error.message
          }
        });

        if (typeof runtimeContext.onCheckpoint === 'function') {
          await runtimeContext.onCheckpoint({
            step: stepNumber,
            planRevision,
            reason: 'step_failed'
          });
        }

        throw error;
      }
    }

    return {
      status:
        lastEvaluation
          ? lastEvaluation.outcome
          : 'done',

      result: lastResult,

      evaluation:
        lastEvaluation || {
          outcome: 'done',
          nextAction: null,
          reason: 'اكتملت خطوات التنفيذ'
        },

      stepsExecuted:
        stepResults.length,

      stepResults
    };
  }

  resolveStepInput({
    step,
    stepNumber,
    context,
    stepResults,
    lastResult
  }) {
    return this.resultReferenceResolver.resolve(
      step.input,
      {
        executionId:
          context.executionId,

        requestId:
          context.requestId,

        input:
          context.input,

        currentStep:
          stepNumber,

        previousResult:
          lastResult,

        stepResults
      }
    );
  }

  restoreLoopState({
    steps,
    context,
    completedSteps,
    stepResults,
    planRevision = 1
  }) {
    if (!context || !Array.isArray(context.steps)) {
      return;
    }

    const persistedSteps =
      context.steps
        .filter(
          (item) =>
            item &&
            item.status === 'completed' &&
            Number(item.planRevision || 1) === planRevision
        )
        .sort(
          (a, b) =>
            Number(a.step) - Number(b.step)
        );

    for (const persistedStep of persistedSteps) {
      const stepNumber =
        Number(persistedStep.step);

      if (
        !Number.isInteger(stepNumber) ||
        stepNumber < 1 ||
        stepNumber > steps.length
      ) {
        continue;
      }

      const currentStep =
        steps[stepNumber - 1];

      if (!currentStep) {
        continue;
      }

      if (
        currentStep.tool &&
        persistedStep.tool &&
        currentStep.tool !== persistedStep.tool
      ) {
        throw new AppError(
          `الخطوة ${stepNumber} المستعادة لا تطابق الأداة الموجودة في الخطة`,
          409,
          'RESUME_STEP_TOOL_MISMATCH'
        );
      }

      completedSteps.add(stepNumber);

      stepResults.push({
        step: stepNumber,
        planRevision,
        tool:
          persistedStep.tool ||
          currentStep.tool,
        input:
          currentStep.input,
        originalInput:
          currentStep.input,
        dependsOn:
          currentStep.dependsOn,
        result:
          persistedStep.result,
        success: true,
        completedAt:
          persistedStep.completedAt || null,
        resumed: true
      });
    }

    context.record(
      'execution.resume.state_restored',
      {
        completedSteps:
          Array.from(completedSteps).sort(
            (a, b) => a - b
          ),
        stepResults:
          stepResults.length
      }
    );
  }

  validateDependencies(steps) {
    const stepNumbers = new Set(
      steps.map((_, index) => index + 1)
    );

    for (
      let index = 0;
      index < steps.length;
      index += 1
    ) {
      const step = steps[index];
      const stepNumber = index + 1;

      if (step.dependsOn === null) {
        continue;
      }

      if (!Number.isInteger(step.dependsOn)) {
        throw new AppError(
          `dependsOn في الخطوة ${stepNumber} غير صالح`,
          500,
          'INVALID_STEP_DEPENDENCY'
        );
      }

      if (step.dependsOn === stepNumber) {
        throw new AppError(
          `الخطوة ${stepNumber} لا يمكن أن تعتمد على نفسها`,
          500,
          'SELF_STEP_DEPENDENCY'
        );
      }

      if (!stepNumbers.has(step.dependsOn)) {
        throw new AppError(
          `الخطوة ${stepNumber} تعتمد على خطوة غير موجودة`,
          500,
          'DEPENDENCY_STEP_NOT_FOUND'
        );
      }

      if (step.dependsOn > stepNumber) {
        throw new AppError(
          `الخطوة ${stepNumber} تعتمد على خطوة مستقبلية`,
          500,
          'FORWARD_STEP_DEPENDENCY'
        );
      }
    }
  }

  enforceDependency({
    step,
    stepNumber,
    completedSteps,
    context
  }) {
    if (step.dependsOn === null) {
      return;
    }

    if (!completedSteps.has(step.dependsOn)) {
      context.record(
        'dependency.failed',
        {
          step: stepNumber,
          dependsOn: step.dependsOn,
          reason: 'dependency_not_completed'
        }
      );

      throw new AppError(
        `الخطوة ${stepNumber} لا يمكن تنفيذها قبل اكتمال الخطوة ${step.dependsOn}`,
        500,
        'DEPENDENCY_NOT_COMPLETED'
      );
    }

    context.record(
      'dependency.satisfied',
      {
        step: stepNumber,
        dependsOn: step.dependsOn
      }
    );
  }

  buildStepContext({
    plan,
    context,
    runtimeContext,
    step,
    stepNumber,
    previousResult,
    stepResults
  }) {
    return {
      ...runtimeContext,

      executionId:
        context.executionId,

      requestId:
        context.requestId,

      input:
        context.input,

      plan,

      step:
        stepNumber,

      tool:
        step.tool,

      stepInput:
        step.input,

      dependsOn:
        step.dependsOn,

      previousResult,

      previousSteps:
        stepResults.map((item) => ({
          step: item.step,
          tool: item.tool,
          result: item.result,
          success: item.success,
          completedAt:
            item.completedAt
        })),

      observations:
        context.observations,

      execution: {
        status: context.status,
        currentStep:
          context.currentStep,
        stepsExecuted:
          context.steps.length
      }
    };
  }

  authorizeAgentStep({ step, stepNumber, plan, runtimeContext, context }) {
    if (!this.agentRegistry) {
      return null;
    }

    const agentId =
      step.agentId ||
      plan.agentId ||
      runtimeContext.agentId ||
      'ORIENT_RUNTIME';

    const capability =
      step.capability ||
      `tool:${step.tool}`;

    const agent = this.agentRegistry.require(agentId);

    if (!agent.canUseCapability(capability)) {
      context.record('agent.boundary.denied', {
        step: stepNumber,
        agentId,
        capability,
        tool: step.tool,
        reason: 'capability_not_declared'
      });

      throw new AppError(
        `Agent "${agentId}" is not authorized for capability "${capability}"`,
        403,
        'AGENT_CAPABILITY_FORBIDDEN'
      );
    }

    context.record('agent.boundary.authorized', {
      step: stepNumber,
      agentId,
      capability,
      tool: step.tool
    });

    return { agentId, capability };
  }

  normalizeSteps(plan) {
    if (Array.isArray(plan.steps)) {
      return plan.steps
        .filter(
          (step) =>
            step &&
            typeof step === 'object'
        )
        .map((step) => ({
          step:
            step.step === undefined
              ? null
              : step.step,

          tool:
            typeof step.tool === 'string'
              ? step.tool.trim()
              : null,

          input:
            step.input === undefined
              ? null
              : step.input,

          dependsOn:
            step.dependsOn === undefined
              ? null
              : step.dependsOn,

          agentId:
            typeof step.agentId === 'string'
              ? step.agentId.trim()
              : null,

          capability:
            typeof step.capability === 'string'
              ? step.capability.trim()
              : null,

          targetAgentId:
            typeof step.targetAgentId === 'string'
              ? step.targetAgentId.trim()
              : null,

          targetCapability:
            typeof step.targetCapability === 'string'
              ? step.targetCapability.trim()
              : null,

          invocationReason:
            typeof step.invocationReason === 'string'
              ? step.invocationReason.trim()
              : null,

          memoryScope:
            typeof step.memoryScope === 'string'
              ? step.memoryScope.trim()
              : null
        }));
    }

    if (plan.tool) {
      return [
        {
          step: 1,
          tool: plan.tool,
          input:
            plan.input === undefined
              ? null
              : plan.input,
          dependsOn: null,
          agentId: typeof plan.agentId === 'string' ? plan.agentId.trim() : null,
          capability: typeof plan.capability === 'string' ? plan.capability.trim() : null,
          targetAgentId: typeof plan.targetAgentId === 'string' ? plan.targetAgentId.trim() : null,
          targetCapability: typeof plan.targetCapability === 'string' ? plan.targetCapability.trim() : null,
          invocationReason: typeof plan.invocationReason === 'string' ? plan.invocationReason.trim() : null,
          memoryScope: typeof plan.memoryScope === 'string' ? plan.memoryScope.trim() : null
        }
      ];
    }

    return [];
  }

  evaluate({
    plan,
    step,
    result,
    stepNumber
  }) {
    return this.evaluationEngine.evaluate({
      plan,
      step,
      result,
      stepNumber,
      observations: []
    }).toJSON();
  }
}

module.exports = AgentLoop;
