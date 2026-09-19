class PolicyDecision {
  constructor({
    allowed,
    reason = '',
    capability = null
  } = {}) {
    this.allowed = Boolean(allowed);
    this.reason = reason;
    this.capability = capability;
  }

  toJSON() {
    return { ...this };
  }

  static allow(capability, reason = 'مسموح') {
    return new PolicyDecision({
      allowed: true,
      capability,
      reason
    });
  }

  static deny(capability, reason = 'غير مسموح') {
    return new PolicyDecision({
      allowed: false,
      capability,
      reason
    });
  }
}

module.exports = PolicyDecision;
