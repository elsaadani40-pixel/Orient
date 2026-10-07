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
      quotaPolicy instanceof TenantQuotaPolicy
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

    this.quotaReady = this.tenantQuotaRepository?.ensureTenant
      ? this.tenantQuotaRepository.ensureTenant(this.tenantId, this.tenantQuotaPolicy)
      : Promise.resolve();

    this.recoveryReady =
      !workflowScheduler && this.workflowRepository?.findAll
        ? Promise.resolve(this.workflowScheduler.recoverPersisted())
        : Promise.resolve(0);
  }

  shutdown(options = {}) {
    return this.workflowScheduler?.shutdown
      ? this.workflowScheduler.shutdown(options)
      : null;
  }
}

module.exports = RuntimeInfrastructureCoordinator;
