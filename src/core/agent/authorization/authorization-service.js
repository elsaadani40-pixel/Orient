const AppError = require('../../errors/AppError');

class AuthorizationService {
  constructor({
    capabilityMapper,
    capabilityPolicy
  } = {}) {
    if (!capabilityMapper) {
      throw new TypeError(
        'capabilityMapper is required'
      );
    }

    if (!capabilityPolicy) {
      throw new TypeError(
        'capabilityPolicy is required'
      );
    }

    this.capabilityMapper =
      capabilityMapper;

    this.capabilityPolicy =
      capabilityPolicy;
  }

  authorize(tool) {
    if (!tool || typeof tool !== 'string') {
      throw new AppError(
        'اسم الأداة مطلوب للتفويض',
        500,
        'AUTHORIZATION_TOOL_REQUIRED'
      );
    }

    const capability =
      this.capabilityMapper.get(tool);

    if (!capability) {
      return {
        allowed: false,
        tool,
        capability: null,
        reason: 'لا توجد Capability مرتبطة بالأداة'
      };
    }

    const decision =
      this.capabilityPolicy.authorize(
        capability
      );

    return {
      allowed: decision.allowed,
      tool,
      capability,
      reason: decision.reason
    };
  }

  assertAuthorized(tool) {
    const decision =
      this.authorize(tool);

    if (!decision.allowed) {
      throw new AppError(
        `الأداة "${tool}" غير مصرح بها`,
        403,
        'TOOL_NOT_AUTHORIZED'
      );
    }

    return decision;
  }
}

module.exports = AuthorizationService;
