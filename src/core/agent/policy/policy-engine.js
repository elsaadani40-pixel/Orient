const PolicyDecision = require('./policy-decision');

class PolicyEngine {
  constructor({ capabilities = [] } = {}) {
    this.capabilities = new Set(capabilities);
  }

  authorize(capability) {
    if (!capability) {
      return PolicyDecision.deny(
        null,
        'Capability مطلوبة'
      );
    }

    if (!this.capabilities.has(capability)) {
      return PolicyDecision.deny(
        capability,
        'Capability غير مصرح بها'
      );
    }

    return PolicyDecision.allow(
      capability
    );
  }

  add(capability) {
    if (capability) {
      this.capabilities.add(capability);
    }

    return this;
  }
}

module.exports = PolicyEngine;
