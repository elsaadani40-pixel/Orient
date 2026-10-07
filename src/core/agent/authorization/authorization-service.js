const AppError = require('../../errors/AppError');

class AuthorizationService {
  constructor({ capabilityMapper, capabilityPolicy, approvalService = null } = {}) {
    if (!capabilityMapper) throw new TypeError('capabilityMapper is required');
    if (!capabilityPolicy) throw new TypeError('capabilityPolicy is required');
    this.capabilityMapper = capabilityMapper;
    this.capabilityPolicy = capabilityPolicy;
    this.approvalService = approvalService;
  }

  async authorize(tool, { executionId = null, step = null, planRevision = 1, approval = null, scope = {}, tenantId = null } = {}) {
    if (!tool || typeof tool !== 'string') throw new AppError('اسم الأداة مطلوب للتفويض', 500, 'AUTHORIZATION_TOOL_REQUIRED');
    const capability = this.capabilityMapper.get(tool);
    if (!capability) return { allowed: false, tool, capability: null, reason: 'لا توجد Capability مرتبطة بالأداة' };
    const decision = this.capabilityPolicy.authorize(capability);
    const risk = this.capabilityPolicy.riskOf(capability);
    if (!decision.allowed) return { allowed: false, tool, capability, risk, requiresApproval: false, reason: decision.reason };
    const requiresApproval = typeof this.capabilityPolicy.requiresApproval === 'function' && this.capabilityPolicy.requiresApproval(capability);
    if (!requiresApproval) return { allowed: true, tool, capability, risk, requiresApproval: false, reason: decision.reason };
    if (!this.approvalService) return { allowed: false, tool, capability, risk, requiresApproval: true, reason: 'APPROVAL_SERVICE_REQUIRED' };
    const checked = await this.approvalService.validate({ approval, executionId, step, tool, capability, planRevision, scope, tenantId });
    return { allowed: checked.allowed, tool, capability, risk, requiresApproval: true, approval: checked.approval || null, reason: checked.reason };
  }

  async assertAuthorized(tool, context = {}) {
    const decision = await this.authorize(tool, context);
    if (!decision.allowed) throw new AppError('الأداة "' + tool + '" غير مصرح بها: ' + decision.reason, 403, decision.reason === 'APPROVAL_REQUIRED' ? 'APPROVAL_REQUIRED' : decision.reason);
    return decision;
  }
}

module.exports = AuthorizationService;
