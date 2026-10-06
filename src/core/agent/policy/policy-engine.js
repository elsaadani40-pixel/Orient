const PolicyDecision = require('./policy-decision');

const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

class PolicyEngine {
  constructor({ capabilities = [], riskByCapability = {}, approvalRequiredAt = 'high' } = {}) {
    this.capabilities = new Set(capabilities);
    this.riskByCapability = new Map(Object.entries(riskByCapability));
    this.approvalRequiredAt = approvalRequiredAt;
  }
  authorize(capability) {
    if (!capability) return PolicyDecision.deny(null, 'Capability مطلوبة');
    if (!this.capabilities.has(capability)) return PolicyDecision.deny(capability, 'Capability غير مصرح بها');
    return PolicyDecision.allow(capability);
  }
  riskOf(capability) { return this.riskByCapability.get(capability) || 'low'; }
  requiresApproval(capability) { return (RISK_ORDER[this.riskOf(capability)] ?? 0) >= (RISK_ORDER[this.approvalRequiredAt] ?? 2); }
  add(capability, { risk = 'low' } = {}) { if (capability) { this.capabilities.add(capability); this.riskByCapability.set(capability, risk); } return this; }
}

PolicyEngine.RISK_ORDER = RISK_ORDER;
module.exports = PolicyEngine;