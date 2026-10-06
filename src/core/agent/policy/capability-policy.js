const PolicyDecision = require('./policy-decision');

class CapabilityPolicy {
  constructor({ capabilityRegistry } = {}) {
    if (!capabilityRegistry) {
      throw new TypeError(
        'capabilityRegistry is required'
      );
    }

    this.capabilityRegistry =
      capabilityRegistry;
  }

  riskOf(capability) {
    const entry = this.capabilityRegistry.get(capability);
    return entry?.risk || 'low';
  }

  requiresApproval(capability) {
    return ['high', 'critical'].includes(this.riskOf(capability));
  }

  authorize(capability) {
    if (!capability) {
      return PolicyDecision.deny(
        null,
        'Capability مطلوبة'
      );
    }

    if (!this.capabilityRegistry.has(capability)) {
      return PolicyDecision.deny(
        capability,
        'Capability غير مسجلة'
      );
    }

    return PolicyDecision.allow(
      capability,
      'Capability مسجلة ومسموح بها'
    );
  }
}

module.exports = CapabilityPolicy;
