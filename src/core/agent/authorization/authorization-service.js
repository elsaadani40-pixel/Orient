const AppError = require('../../errors/AppError');

class AuthorizationService {
  constructor({ capabilityMapper, capabilityPolicy, approvalService = null, capabilityGovernance = null } = {}) {
    if (!capabilityMapper) throw new TypeError('capabilityMapper is required');
    if (!capabilityPolicy) throw new TypeError('capabilityPolicy is required');
    this.capabilityMapper = capabilityMapper;
    this.capabilityPolicy = capabilityPolicy;
    this.approvalService = approvalService;
    this.capabilityGovernance = capabilityGovernance;
  }

  async authorize(tool, { executionId = null, step = null, planRevision = 1, approval = null, scope = {}, tenantId = null, agentId = null, operationId = null } = {}) {
    if (!tool || typeof tool !== 'string') throw new AppError('اسم الأداة مطلوب للتفويض', 500, 'AUTHORIZATION_TOOL_REQUIRED');
    if (this.capabilityGovernance) {
      if (!agentId) {
        return {
          allowed: false,
          tool,
          capability: null,
          requiresApproval: false,
          reason: 'AGENT_ID_REQUIRED'
        };
      }

      try {
        const governed = this.capabilityGovernance.authorizeTool({
          agentId,
          tool
        });
        if (governed.capability) {
          // Governance is authoritative for the agent/tool boundary.
        }
      } catch (error) {
        return {
          allowed: false,
          tool,
          capability: this.capabilityMapper.get(tool),
          requiresApproval: false,
          reason: error.code || 'AGENT_TOOL_CAPABILITY_FORBIDDEN'
        };
      }
    }

    const capability = this.capabilityMapper.get(tool);
    if (!capability) return { allowed: false, tool, capability: null, reason: 'لا توجد Capability مرتبطة بالأداة' };
    const decision = this.capabilityPolicy.authorize(capability);
    const risk = this.capabilityPolicy.riskOf(capability);
    if (!decision.allowed) return { allowed: false, tool, capability, risk, requiresApproval: false, reason: decision.reason };
    const requiresApproval = typeof this.capabilityPolicy.requiresApproval === 'function' && this.capabilityPolicy.requiresApproval(capability);
    if (!requiresApproval) return { allowed: true, tool, capability, risk, requiresApproval: false, reason: decision.reason };
    if (!this.approvalService) return { allowed: false, tool, capability, risk, requiresApproval: true, reason: 'APPROVAL_SERVICE_REQUIRED' };
    const checked = await this.approvalService.validate({ approval, executionId, step, tool, capability, planRevision, scope, tenantId, agentId, operationId });
    return { allowed: checked.allowed, tool, capability, risk, requiresApproval: true, approval: checked.approval || null, reason: checked.reason };
  }

  async assertAuthorized(tool, context = {}) {
    const decision = await this.authorize(tool, context);
    if (!decision.allowed) { const error = new AppError('الأداة "' + tool + '" غير مصرح بها: ' + decision.reason, 403, decision.reason === 'APPROVAL_REQUIRED' ? 'APPROVAL_REQUIRED' : decision.reason); error.capability = decision.capability || null; error.risk = decision.risk || null; throw error; }
    return decision;
  }
}

module.exports = AuthorizationService;
