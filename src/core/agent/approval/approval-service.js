const crypto = require('crypto');

class ApprovalService {
  constructor({ clock = () => Date.now() } = {}) { this.clock = clock; this.approvals = new Map(); }
  issue({ executionId, step, tool, capability, scope = {}, ttlMs = 300000, metadata = {} } = {}) {
    if (!executionId || !tool || !capability) throw new TypeError('executionId, tool and capability are required');
    if (!Number.isInteger(step) || step < 1) throw new TypeError('step must be a positive integer');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive');
    const now = this.clock();
    const value = { approvalId: crypto.randomUUID(), executionId: String(executionId), step, tool, capability, scope: { ...scope }, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(), used: false, metadata: { ...metadata } };
    this.approvals.set(value.approvalId, value);
    return { ...value };
  }
  validate({ approval, executionId, step, tool, capability, scope = {} } = {}) {
    if (!approval || typeof approval !== 'object') return { allowed: false, reason: 'APPROVAL_REQUIRED' };
    const stored = this.approvals.get(approval.approvalId);
    if (!stored) return { allowed: false, reason: 'APPROVAL_NOT_FOUND' };
    if (stored.used) return { allowed: false, reason: 'APPROVAL_ALREADY_USED' };
    if (this.clock() >= Date.parse(stored.expiresAt)) return { allowed: false, reason: 'APPROVAL_EXPIRED' };
    if (stored.executionId !== String(executionId) || stored.step !== step || stored.tool !== tool || stored.capability !== capability) return { allowed: false, reason: 'APPROVAL_SCOPE_MISMATCH' };
    if (!Object.entries(stored.scope).every(([key, value]) => scope[key] === value)) return { allowed: false, reason: 'APPROVAL_SCOPE_MISMATCH' };
    return { allowed: true, approval: { ...stored } };
  }
  consume(approvalId) { const stored = this.approvals.get(approvalId); if (!stored || stored.used) return false; stored.used = true; stored.usedAt = new Date(this.clock()).toISOString(); return true; }
}

module.exports = ApprovalService;