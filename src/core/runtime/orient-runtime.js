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
const RequestExecutionCoordinator = require('./request-execution-coordinator');

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

    this.requestExecutionCoordinator = new RequestExecutionCoordinator({
      agentOrchestrator: this.agentOrchestrator,
      agentExecutionCoordinator: this.agentExecutionCoordinator,
      recoveryCoordinator: this.executionRecoveryCoordinator,
      persistence: this.persistence,
      persistenceCoordinator: this.persistenceCoordinator,
      quotaService: this.tenantQuotaService,
      quotaPolicy: this.tenantQuotaPolicy,
      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      maxInputChars: this.maxInputChars
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
    return this.requestExecutionCoordinator.planFingerprint(plan);
  }

  validateReplannedPlan(plan, previousFingerprint) {
    return this.requestExecutionCoordinator.validateReplannedPlan(plan, previousFingerprint);
  }

  shutdown(options = {}) {
    return this.workflowScheduler?.shutdown
      ? this.workflowScheduler.shutdown(options)
      : null;
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

}

module.exports =
  OrientRuntime;
