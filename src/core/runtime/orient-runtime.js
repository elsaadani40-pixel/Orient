const version = require('../version');

const AgentLoop =
  require('../execution/agent-loop');

const AgentRegistry =
  require('../agent/boundary/agent-registry');
const { AgentDefinition } =
  require('../agent/boundary/agent-definition');

const ApprovalService =
  require('../agent/approval/approval-service');

const ExecutionPersistenceCoordinator = require('./execution-persistence-coordinator');
const WorkflowExecutionCoordinator = require('./workflow-execution-coordinator');
const AgentExecutionCoordinator = require('./agent-execution-coordinator');
const ExecutionRecoveryCoordinator = require('./execution-recovery-coordinator');
const RequestExecutionCoordinator = require('./request-execution-coordinator');
const RuntimeInfrastructureCoordinator = require('./runtime-infrastructure-coordinator');

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
    workflowDispatchWindow = 2,
    workflowAgingQuantumMs = 30000,
    maxRetries = 2,
    leaseDurationMs = 30000,
    maxInputChars = 100000,
    maxToolInputChars = 50000,
    quotaPolicy = null,
    quotaService = null,
    agentRegistry = null,
    agentInvocationService = null,
    capabilityGovernance = null,
    approvalDecisionAuthorizer = null
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
            tenantId: tenantId || 'local',
            decisionAuthorizer: approvalDecisionAuthorizer
          })
        : null);

    if (this.approvalService && approvalDecisionAuthorizer && !this.approvalService.decisionAuthorizer) {
      this.approvalService.decisionAuthorizer = approvalDecisionAuthorizer;
    }

    if (this.authorizationService && !this.authorizationService.approvalService) {
      this.authorizationService.approvalService = this.approvalService;
    }

    if (this.authorizationService && capabilityGovernance) {
      this.authorizationService.capabilityGovernance = capabilityGovernance;
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

    this.infrastructureCoordinator = new RuntimeInfrastructureCoordinator({
      persistence,
      workflowScheduler,
      tenantId: this.tenantId,
      maxConcurrent,
      maxQueueDepth,
      workflowDispatchWindow,
      workflowAgingQuantumMs,
      maxRetries,
      leaseDurationMs,
      maxInputChars,
      maxToolInputChars,
      quotaPolicy,
      quotaService
    });

    this.workflowRepository = this.infrastructureCoordinator.workflowRepository;
    this.tenantQuotaRepository = this.infrastructureCoordinator.tenantQuotaRepository;
    this.workflowScheduler = this.infrastructureCoordinator.workflowScheduler;
    this.tenantQuotaPolicy = this.infrastructureCoordinator.tenantQuotaPolicy;
    this.quotaReady = this.infrastructureCoordinator.quotaReady;
    this.tenantQuotaService = this.infrastructureCoordinator.tenantQuotaService;
    this.recoveryReady = this.infrastructureCoordinator.recoveryReady;

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
        agentRegistry: this.agentRegistry,
        agentInvocationService,
        capabilityGovernance
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

    this.requestExecutionCoordinator = new RequestExecutionCoordinator({
      agentOrchestrator: this.agentOrchestrator,
      agentExecutionCoordinator: this.agentExecutionCoordinator,
      recoveryCoordinator: this.executionRecoveryCoordinator,
      persistence: this.persistence,
      persistenceCoordinator: this.persistenceCoordinator,
      quotaService: this.tenantQuotaService,
      quotaPolicy: this.tenantQuotaPolicy,
      approvalService: this.approvalService,
      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      maxInputChars: this.maxInputChars
    });

    this.name =
      'ORIENT_RUNTIME';

    this.version =
      version;
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
    return this.requestExecutionCoordinator.planFingerprint(plan);
  }

  validateReplannedPlan(plan, previousFingerprint) {
    return this.requestExecutionCoordinator.validateReplannedPlan(plan, previousFingerprint);
  }

  shutdown(options = {}) {
    return this.infrastructureCoordinator.shutdown(options);
  }

  async executeWorkflow(input, options = {}) {
    return this.workflowExecutionCoordinator.execute(input, options);
  }

  async execute(input, options = {}) {
    return this.requestExecutionCoordinator.execute(input, options);
  }

  async resume(executionId, options = {}) {
    try {
      const result = await this.requestExecutionCoordinator.resume(executionId, options);
      await this.workflowExecutionCoordinator.reconcileApprovalResume(executionId, result);
      return result;
    } catch (error) {
      if (error?.code === 'APPROVAL_REQUIRED' && error.executionContext?.approvalId) {
        await this.workflowExecutionCoordinator.updateApprovalChallenge(
          executionId,
          error.executionContext.approvalId
        );
      } else if (typeof this.persistence?.executions?.findById === 'function') {
        const durable = await this.persistence.executions.findById(executionId, { tenantId: this.tenantId });
        if (durable && ['completed', 'failed', 'cancelled'].includes(String(durable.status || '').toLowerCase())) {
          await this.workflowExecutionCoordinator.reconcileApprovalResume(executionId, { execution: durable });
        }
      }
      throw error;
    }
  }

  async decideApproval(options = {}) {
    if (!this.approvalService?.decide) {
      throw Object.assign(new Error('Durable approval service is required'), { code: 'APPROVAL_SERVICE_REQUIRED' });
    }
    try {
      return await this.approvalService.decide({ ...options, tenantId: options.tenantId || this.tenantId });
    } catch (error) {
      if (error?.code === 'APPROVAL_EXPIRED' && options.executionId && options.approvalId) {
        try {
          if (typeof this.persistence?.executions?.requestCancellation === 'function') {
            await this.persistence.executions.requestCancellation(
              options.executionId,
              'approval_expired',
              { tenantId: options.tenantId || this.tenantId }
            );
          }
          await this.workflowExecutionCoordinator.expireApprovalWorkflow(
            options.executionId,
            options.approvalId
          );
        } catch (reconciliationError) {
          throw Object.assign(new Error('Expired approval could not be reconciled safely'), {
            code: 'APPROVAL_EXPIRY_RECONCILIATION_FAILED',
            cause: reconciliationError,
            approvalError: error
          });
        }
      }
      throw error;
    }
  }

  async cancelExecution(executionId, { reason = 'Execution cancellation requested' } = {}) {
    if (!this.persistence?.executions?.requestCancellation) {
      throw Object.assign(new Error('Durable execution cancellation storage is required'), {
        code: 'EXECUTION_CANCELLATION_STORAGE_REQUIRED'
      });
    }
    if (!executionId) {
      throw Object.assign(new Error('executionId is required'), { code: 'EXECUTION_ID_REQUIRED' });
    }

    const requested = await this.persistence.executions.requestCancellation(
      executionId,
      reason,
      { tenantId: this.tenantId }
    );

    if (!requested) {
      throw Object.assign(new Error(`Execution not found: ${executionId}`), {
        code: 'EXECUTION_NOT_FOUND'
      });
    }

    await this.workflowExecutionCoordinator.cancelApprovalWorkflow(executionId, reason);

    return {
      executionId: requested.executionId,
      tenantId: requested.metadata?.tenantId || this.tenantId,
      status: requested.status,
      cancellationRequested: Boolean(requested.cancellationRequested),
      cancellationReason: requested.cancellationReason || null,
      terminal: ['completed', 'failed', 'cancelled'].includes(requested.status)
    };
  }

  async getExecutionApprovals(executionId) {
    if (!this.approvalService?.listForExecution) {
      throw Object.assign(new Error('Approval service is required for approval status'), {
        code: 'APPROVAL_SERVICE_REQUIRED'
      });
    }

    if (!executionId) {
      throw Object.assign(new Error('executionId is required'), {
        code: 'EXECUTION_ID_REQUIRED'
      });
    }

    if (this.persistence?.executions?.findById) {
      const execution = await this.persistence.executions.findById(executionId, {
        tenantId: this.tenantId
      });
      if (!execution) {
        throw Object.assign(new Error(`Execution not found: ${executionId}`), {
          code: 'EXECUTION_NOT_FOUND'
        });
      }
    }

    return this.approvalService.listForExecution({
      executionId,
      tenantId: this.tenantId
    });
  }

  async listExecutionSummaries({ limit = 50, offset = 0 } = {}) {
    if (!this.persistence?.executions?.findAll) {
      throw Object.assign(new Error('Durable execution storage is required for history'), {
        code: 'EXECUTION_STORAGE_REQUIRED'
      });
    }
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
    const boundedOffset = Number.isInteger(offset) ? Math.max(0, Math.min(offset, 10000)) : 0;
    let total;
    let page;
    if (typeof this.persistence.executions.findPage === 'function') {
      const result = await this.persistence.executions.findPage({
        tenantId: this.tenantId,
        limit: boundedLimit,
        offset: boundedOffset
      });
      total = result.total;
      page = result.executions;
    } else {
      const executions = await this.persistence.executions.findAll({ tenantId: this.tenantId });
      const ordered = executions.sort((a, b) =>
        Date.parse(b.updatedAt || b.startedAt || 0) - Date.parse(a.updatedAt || a.startedAt || 0)
      );
      total = ordered.length;
      page = ordered.slice(boundedOffset, boundedOffset + boundedLimit);
    }
    return {
      total,
      limit: boundedLimit,
      offset: boundedOffset,
      executions: page.map(execution => ({
        executionId: execution.executionId,
        requestId: execution.requestId,
        goalId: execution.goalId,
        status: execution.status,
        agentLifecycle: execution.agentLifecycle,
        currentStep: execution.currentStep,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        updatedAt: execution.updatedAt,
        cancellationRequested: Boolean(execution.cancellationRequested)
      }))
    };
  }

  async listPendingApprovals({ limit = 100 } = {}) {
    if (!this.approvalService?.listPending) {
      throw Object.assign(new Error('Approval service is required for the pending inbox'), {
        code: 'APPROVAL_SERVICE_REQUIRED'
      });
    }
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    return this.approvalService.listPending({ tenantId: this.tenantId, limit: boundedLimit });
  }

  async getExecutionEvents(executionId, { limit = 200 } = {}) {
    if (!this.persistence?.events?.findByExecutionId) {
      throw Object.assign(new Error('Durable execution event storage is required'), {
        code: 'EXECUTION_EVENT_STORAGE_REQUIRED'
      });
    }
    if (!executionId) {
      throw Object.assign(new Error('executionId is required'), {
        code: 'EXECUTION_ID_REQUIRED'
      });
    }
    const execution = await this.persistence?.executions?.findById?.(executionId, {
      tenantId: this.tenantId
    });
    if (!execution) {
      throw Object.assign(new Error(`Execution not found: ${executionId}`), {
        code: 'EXECUTION_NOT_FOUND'
      });
    }
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 200;
    const events = await this.persistence.events.findByExecutionId(executionId, {
      tenantId: this.tenantId,
      limit: boundedLimit
    });
    return events.slice(-boundedLimit);
  }

  async getExecutionStatus(executionId) {
    if (!this.persistence?.executions?.findById) {
      throw Object.assign(new Error('Durable execution storage is required for status'), {
        code: 'EXECUTION_STORAGE_REQUIRED'
      });
    }

    if (!executionId) {
      throw Object.assign(new Error('executionId is required'), {
        code: 'EXECUTION_ID_REQUIRED'
      });
    }

    const execution = await this.persistence.executions.findById(executionId, {
      tenantId: this.tenantId
    });

    if (!execution) {
      throw Object.assign(new Error(`Execution not found: ${executionId}`), {
        code: 'EXECUTION_NOT_FOUND'
      });
    }

    return {
      executionId: execution.executionId,
      requestId: execution.requestId,
      goalId: execution.goalId,
      tenantId: execution.metadata?.tenantId || this.tenantId,
      status: execution.status,
      cancellationRequested: Boolean(execution.cancellationRequested),
      cancellationReason: execution.cancellationReason || null,
      agentLifecycle: execution.agentLifecycle,
      currentStep: execution.currentStep,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      updatedAt: execution.updatedAt,
      result: execution.result
    };
  }

}

module.exports =
  OrientRuntime;
