const crypto = require('crypto');

class ApprovalService {
  constructor({ clock = () => Date.now(), repository = null, tenantId = null } = {}) {
    this.clock = clock;
    this.repository = repository;
    this.tenantId = tenantId;
    this.approvals = new Map();
  }

  async issue({
    executionId, step, tool, capability, planRevision = 1,
    scope = {}, ttlMs = 300000, metadata = {}, tenantId = this.tenantId
  } = {}) {
    if (!executionId || !tool || !capability) throw new TypeError('executionId, tool and capability are required');
    if (!Number.isInteger(step) || step < 1) throw new TypeError('step must be a positive integer');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive');
    const now = this.clock();
    const value = {
      approvalId: crypto.randomUUID(), executionId: String(executionId), step, planRevision,
      tool, capability, scope: { ...scope },
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
      used: false, tenantId,
      metadata: { ...metadata, ...(tenantId ? { tenantId } : {}) }
    };
    if (this.repository?.save) await this.repository.save(value, { tenantId });
    this.approvals.set(value.approvalId, value);
    return { ...value };
  }

  async validate({
    approval, executionId, step, tool, capability, planRevision = 1,
    scope = {}, tenantId = this.tenantId
  } = {}) {
    if (!approval || typeof approval !== 'object') return { allowed: false, reason: 'APPROVAL_REQUIRED' };
    const stored = this.repository?.findById
      ? await this.repository.findById(approval.approvalId, { tenantId })
      : this.approvals.get(approval.approvalId);
    if (!stored) return { allowed: false, reason: 'APPROVAL_NOT_FOUND' };
    if (tenantId && stored.tenantId !== tenantId && stored.metadata?.tenantId !== tenantId) return { allowed: false, reason: 'APPROVAL_TENANT_MISMATCH' };
    if (stored.used) return { allowed: false, reason: 'APPROVAL_ALREADY_USED' };
    if (this.clock() >= Date.parse(stored.expiresAt)) return { allowed: false, reason: 'APPROVAL_EXPIRED' };
    if (stored.executionId !== String(executionId) || stored.step !== step || stored.planRevision !== planRevision || stored.tool !== tool || stored.capability !== capability) return { allowed: false, reason: 'APPROVAL_SCOPE_MISMATCH' };
    if (!Object.entries(stored.scope || {}).every(([key, value]) => scope[key] === value)) return { allowed: false, reason: 'APPROVAL_SCOPE_MISMATCH' };
    return { allowed: true, approval: { ...stored } };
  }

  async consume(approvalId, tenantId = this.tenantId) {
    const stored = this.repository?.findById
      ? await this.repository.findById(approvalId, { tenantId })
      : this.approvals.get(approvalId);
    if (!stored || stored.used) return false;
    if (tenantId && stored.tenantId !== tenantId && stored.metadata?.tenantId !== tenantId) return false;
    if (!stored.expiresAt || this.clock() >= Date.parse(stored.expiresAt)) return false;
    const usedAt = new Date(this.clock()).toISOString();
    if (this.repository?.consume) {
      const consumed = await this.repository.consume(approvalId, usedAt, tenantId);
      if (!consumed) return false;
    }
    stored.used = true;
    stored.usedAt = usedAt;
    this.approvals.set(approvalId, stored);
    return true;
  }
}

module.exports = ApprovalService;
