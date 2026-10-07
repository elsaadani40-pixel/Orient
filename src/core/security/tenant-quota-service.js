const AppError = require('../errors/AppError');
const TenantQuotaPolicy = require('./tenant-quota-policy');

class TenantQuotaService {
  constructor({
    tenantId,
    policy = new TenantQuotaPolicy(),
    scheduler = null
  } = {}) {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new AppError(
        'tenantId is required for quota enforcement',
        400,
        'TENANT_QUOTA_TENANT_REQUIRED'
      );
    }

    this.tenantId = tenantId;
    this.policy = policy instanceof TenantQuotaPolicy
      ? policy
      : new TenantQuotaPolicy(policy);
    this.scheduler = scheduler;
  }

  assertTenant(tenantId) {
    if (tenantId !== this.tenantId) {
      throw new AppError(
        'Quota tenant does not match runtime tenant',
        403,
        'TENANT_QUOTA_TENANT_MISMATCH'
      );
    }
  }

  assertInputSize(input, toolInput = null) {
    const inputChars = String(input ?? '').length;
    if (inputChars > this.policy.maxInputChars) {
      throw new AppError(
        'Tenant input quota exceeded',
        413,
        'TENANT_INPUT_QUOTA_EXCEEDED'
      );
    }

    if (toolInput !== null && String(toolInput ?? '').length > this.policy.maxToolInputChars) {
      throw new AppError(
        'Tenant tool input quota exceeded',
        413,
        'TENANT_TOOL_INPUT_QUOTA_EXCEEDED'
      );
    }

    return {
      inputChars,
      maxInputChars: this.policy.maxInputChars,
      maxToolInputChars: this.policy.maxToolInputChars
    };
  }

  assertWorkflowAdmission({ tenantId = this.tenantId } = {}) {
    this.assertTenant(tenantId);

    if (!this.scheduler) {
      return {
        allowed: true,
        queued: 0,
        active: 0
      };
    }

    const queued = this.scheduler.depth();
    const active = this.scheduler.activeCount();

    if (active >= this.policy.maxConcurrent) {
      throw new AppError(
        'Tenant concurrent workflow quota exceeded',
        429,
        'TENANT_CONCURRENCY_QUOTA_EXCEEDED'
      );
    }

    if (queued >= this.policy.maxQueued) {
      throw new AppError(
        'Tenant queued workflow quota exceeded',
        429,
        'TENANT_QUEUE_QUOTA_EXCEEDED'
      );
    }

    return {
      allowed: true,
      queued,
      active,
      limits: {
        maxConcurrent: this.policy.maxConcurrent,
        maxQueued: this.policy.maxQueued
      }
    };
  }

  snapshot() {
    return {
      tenantId: this.tenantId,
      policy: this.policy.toJSON(),
      scheduler: this.scheduler
        ? {
            queued: this.scheduler.depth(),
            active: this.scheduler.activeCount()
          }
        : null
    };
  }
}

module.exports = TenantQuotaService;
