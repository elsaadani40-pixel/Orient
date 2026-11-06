'use strict';

const WorkflowScheduler = require('../workflow/workflow-scheduler');
const AsyncWorkflowScheduler = require('../workflow/async-workflow-scheduler');
const PostgresTenantQuotaRepository = require('../../infrastructure/persistence/postgres/postgres-tenant-quota-repository');
const WorkflowLeaseStore = require('../workflow/workflow-lease-store');
const TenantQuotaPolicy = require('../security/tenant-quota-policy');
const TenantQuotaService = require('../security/tenant-quota-service');

class RuntimeInfrastructureCoordinator {
  constructor({
    persistence = null,
    workflowScheduler = null,
    tenantId = 'local',
    maxConcurrent = 1,
    maxQueueDepth = 1000,
    workflowDispatchWindow = 2,
    workflowAgingQuantumMs = 30000,
    maxRetries = 2,
    leaseDurationMs = 30000,
    maxInputChars = 100000,
    maxToolInputChars = 50000,
    quotaPolicy = null,
    quotaService = null
  } = {}) {
    this.persistence = persistence;
    this.tenantId = tenantId || 'local';

    this.workflowRepository = persistence?.workflows || null;
    this.tenantQuotaRepository =
      persistence?.tenantQuotas ||
      (persistence?.isAsync && persistence?.db
        ? new PostgresTenantQuotaRepository(persistence.db)
        : null);

    this.tenantQuotaPolicy =
      quotaPolicy instanceof TenantQuotaPolicy || (quotaPolicy && typeof quotaPolicy.toJSON === 'function')
        ? quotaPolicy
        : new TenantQuotaPolicy({
            maxConcurrent,
            maxQueued: maxQueueDepth,
            maxInputChars,
            maxToolInputChars,
            maxRetries
          });

    this.workflowScheduler =
      workflowScheduler ||
      (persistence?.isAsync
        ? new AsyncWorkflowScheduler({
            maxConcurrent,
            maxQueueDepth,
            dispatchWindow: workflowDispatchWindow,
            agingQuantumMs: workflowAgingQuantumMs,
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
              ? new WorkflowLeaseStore({
                  repository: persistence.workflowLeases,
                  tenantId: this.tenantId
                })
              : null
          }));

    if (this.workflowScheduler?.async) {
      this.workflowScheduler.quotaPolicy = this.tenantQuotaPolicy;
      this.workflowScheduler.quotaRepository = this.tenantQuotaRepository;
    }

    this.tenantQuotaService =
      quotaService ||
      new TenantQuotaService({
        tenantId: this.tenantId,
        policy: this.tenantQuotaPolicy,
        scheduler: this.workflowScheduler
      });

    if (this.tenantQuotaService.scheduler !== this.workflowScheduler) {
      this.tenantQuotaService.scheduler = this.workflowScheduler;
    }

    // Database-backed startup work must not begin in the constructor: the
    // composition root initializes migrations before calling initialize().
    this.quotaReady = Promise.resolve();
    this.recoveryReady = Promise.resolve(0);
    this.initialization = null;
  }

  initialize() {
    if (!this.initialization) {
      this.initialization = (async () => {
        if (this.tenantQuotaRepository?.ensureTenant) {
          await this.tenantQuotaRepository.ensureTenant(this.tenantId, this.tenantQuotaPolicy);
        }
        this.quotaReady = Promise.resolve();
        if (this.workflowRepository?.findAll || this.workflowRepository?.claimQueued) {
          const recovered = await this.workflowScheduler.recoverPersisted();
          this.recoveryReady = Promise.resolve(recovered);
          return recovered;
        }
        this.recoveryReady = Promise.resolve(0);
        return 0;
      })().catch(error => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  shutdown(options = {}) {
    return this.workflowScheduler?.shutdown
      ? this.workflowScheduler.shutdown(options)
      : null;
  }
}

module.exports = RuntimeInfrastructureCoordinator;
