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
    return this.requestExecutionCoordinator.resume(executionId, options);
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

    const requested = this.persistence.executions.requestCancellation(
      executionId,
      reason,
      { tenantId: this.tenantId }
    );

    if (!requested) {
      throw Object.assign(new Error(`Execution not found: ${executionId}`), {
        code: 'EXECUTION_NOT_FOUND'
      });
    }

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
      tenantId: this.tenantId
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
