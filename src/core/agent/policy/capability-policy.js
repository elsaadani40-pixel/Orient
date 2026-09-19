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
