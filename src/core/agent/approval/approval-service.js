const crypto = require('crypto');

function publicApprovalSummary(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'file_change' && Array.isArray(value.changes)) {
    return {
      kind: 'file_change',
      changeCount: Number.isInteger(value.changeCount) ? Math.max(0, Math.min(value.changeCount, 1000)) : value.changes.length,
      changes: value.changes.slice(0, 10).map(change => {
        const proposedContent = typeof change?.proposedContent === 'string' ? change.proposedContent.slice(0, 32000) : '';
        const proposedContentSha256 = typeof change?.proposedContentSha256 === 'string' ? change.proposedContentSha256.slice(0, 64) : null;
        const contentTruncated = Boolean(change?.contentTruncated);
        const contentHashValid = !contentTruncated && Boolean(proposedContentSha256) &&
          crypto.createHash('sha256').update(proposedContent, 'utf8').digest('hex') === proposedContentSha256;
        return {
          action: ['create', 'update'].includes(change?.action) ? change.action : 'invalid',
          path: typeof change?.path === 'string' ? change.path.slice(0, 512) : '',
          expectedContentSha256: typeof change?.expectedContentSha256 === 'string' ? change.expectedContentSha256.slice(0, 64) : null,
          proposedContentSha256,
          contentHashValid,
          contentBytes: Number.isFinite(change?.contentBytes) ? Math.max(0, Math.min(change.contentBytes, 10_000_000)) : 0,
          lineCount: Number.isFinite(change?.lineCount) ? Math.max(0, Math.min(change.lineCount, 1_000_000)) : 0,
          proposedContent,
          contentTruncated
        };
      }),
      reviewNotice: typeof value.reviewNotice === 'string' ? value.reviewNotice.slice(0, 500) : ''
    };
  }
  if (value.kind === 'tool_action') {
    return {
      kind: 'tool_action',
      tool: typeof value.tool === 'string' ? value.tool.slice(0, 120) : 'unknown'
    };
  }
  return null;
}

class ApprovalService {
  constructor({ clock = () => Date.now(), repository = null, tenantId = null, decisionAuthorizer = null } = {}) {
    this.clock = clock;
    this.repository = repository;
    this.tenantId = tenantId;
    this.decisionAuthorizer = decisionAuthorizer;
    this.approvals = new Map();
  }

  async issue({
    executionId, step, tool, capability, planRevision = 1,
    scope = {}, ttlMs = 300000, metadata = {}, tenantId = this.tenantId,
    agentId = null, operationId = null
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
      metadata: {
        ...metadata,
        ...(tenantId ? { tenantId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(operationId ? { operationId } : {})
      }
    };
    if (this.repository?.save) await this.repository.save(value, { tenantId });
    this.approvals.set(value.approvalId, value);
    return { ...value };
  }

  async validate({
    approval, executionId, step, tool, capability, planRevision = 1,
    scope = {}, tenantId = this.tenantId, agentId = null, operationId = null
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
    if (agentId && stored.metadata?.agentId !== agentId) return { allowed: false, reason: 'APPROVAL_AGENT_MISMATCH' };
    if (operationId && stored.metadata?.operationId !== operationId) return { allowed: false, reason: 'APPROVAL_OPERATION_MISMATCH' };
    if (!Object.entries(stored.scope || {}).every(([key, value]) => scope[key] === value)) return { allowed: false, reason: 'APPROVAL_SCOPE_MISMATCH' };
    return { allowed: true, approval: { ...stored } };
  }

  async findReusable({ executionId, step, tool, planRevision = 1, tenantId = this.tenantId } = {}) {
    if (!executionId || !Number.isInteger(step) || step < 1 || !tool) return null;
    const candidates = this.repository?.findByExecution
      ? await this.repository.findByExecution({ executionId, step, tool, planRevision, tenantId })
      : Array.from(this.approvals.values())
        .filter(record => record.executionId === String(executionId) && Number(record.step) === step && record.tool === tool && Number(record.planRevision || 1) === Number(planRevision))
        .sort((x, y) => Date.parse(y.issuedAt || 0) - Date.parse(x.issuedAt || 0));
    for (const candidate of candidates) {
      if (!candidate || candidate.used) continue;
      if (tenantId && candidate.tenantId !== tenantId && candidate.metadata?.tenantId !== tenantId) continue;
      if (!candidate.expiresAt || this.clock() >= Date.parse(candidate.expiresAt)) continue;
      return { ...candidate };
    }
    return null;
  }

  async listForExecution({ executionId, tenantId = this.tenantId } = {}) {
    if (!executionId) return [];

    const candidates = this.repository?.findByExecution
      ? await this.repository.findByExecution({ executionId, tenantId })
      : Array.from(this.approvals.values())
        .filter(record => record.executionId === String(executionId))
        .sort((a, b) => Date.parse(b.issuedAt || 0) - Date.parse(a.issuedAt || 0));

    return candidates
      .filter(record => record && (!tenantId || record.tenantId === tenantId || record.metadata?.tenantId === tenantId))
      .filter(record => !record.used)
      .filter(record => !record.expiresAt || this.clock() < Date.parse(record.expiresAt))
      .map(record => ({
        approvalId: record.approvalId,
        executionId: record.executionId,
        step: record.step,
        tool: record.tool,
        capability: record.capability,
        scope: { ...(record.scope || {}) },
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        tenantId: record.tenantId,
        ...(publicApprovalSummary(record.metadata?.approvalSummary)
          ? { summary: publicApprovalSummary(record.metadata.approvalSummary) }
          : {})
      }));
  }

  async listPending({ tenantId = this.tenantId, limit = 100 } = {}) {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    const candidates = this.repository?.findPending
      ? await this.repository.findPending({ tenantId, limit: boundedLimit, now: this.clock() })
      : Array.from(this.approvals.values())
        .filter(record => !tenantId || record.tenantId === tenantId || record.metadata?.tenantId === tenantId)
        .sort((a, b) => Date.parse(a.issuedAt || 0) - Date.parse(b.issuedAt || 0));
    return candidates
      .filter(record => record && !record.used)
      .filter(record => !record.expiresAt || this.clock() < Date.parse(record.expiresAt))
      .filter(record => !tenantId || record.tenantId === tenantId || record.metadata?.tenantId === tenantId)
      .slice(0, boundedLimit)
      .map(record => ({
        approvalId: record.approvalId,
        executionId: record.executionId,
        step: record.step,
        tool: record.tool,
        capability: record.capability,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        tenantId: record.tenantId,
        ...(publicApprovalSummary(record.metadata?.approvalSummary)
          ? { summary: publicApprovalSummary(record.metadata.approvalSummary) }
          : {})
      }));
  }


  async decide({ approvalId, decision, actorId, tenantId = this.tenantId } = {}) {
    if (typeof approvalId !== 'string' || !approvalId.trim()) {
      throw Object.assign(new TypeError('approvalId is required'), { code: 'APPROVAL_ID_REQUIRED' });
    }
    if (!['approved', 'rejected'].includes(decision)) {
      throw Object.assign(new TypeError('decision must be approved or rejected'), { code: 'APPROVAL_DECISION_INVALID' });
    }
    if (typeof actorId !== 'string' || !actorId.trim()) {
      throw Object.assign(new TypeError('actorId is required'), { code: 'APPROVAL_ACTOR_REQUIRED' });
    }

    const stored = this.repository?.findById
      ? await this.repository.findById(approvalId, { tenantId })
      : this.approvals.get(approvalId);
    if (!stored) {
      throw Object.assign(new Error('Approval not found'), { code: 'APPROVAL_NOT_FOUND' });
    }
    if (tenantId && stored.tenantId !== tenantId && stored.metadata?.tenantId !== tenantId) {
      throw Object.assign(new Error('Approval tenant mismatch'), { code: 'APPROVAL_TENANT_MISMATCH' });
    }
    if (stored.used) {
      throw Object.assign(new Error('Approval has already been consumed'), { code: 'APPROVAL_ALREADY_USED' });
    }
    if (!stored.expiresAt || this.clock() >= Date.parse(stored.expiresAt)) {
      throw Object.assign(new Error('Approval has expired'), { code: 'APPROVAL_EXPIRED' });
    }
    if (typeof this.decisionAuthorizer !== 'function' ||
        await this.decisionAuthorizer({ actorId, tenantId, decision, approval: { ...stored } }) !== true) {
      throw Object.assign(new Error('Approval decision is not authorized'), { code: 'APPROVAL_DECISION_FORBIDDEN' });
    }

    const decisionRecord = {
      status: decision,
      actorId,
      decidedAt: new Date(this.clock()).toISOString()
    };
    let updated;
    if (this.repository?.recordDecision) {
      updated = await this.repository.recordDecision(approvalId, decisionRecord, tenantId);
    } else {
      const current = stored.decision || null;
      if (current && (current.status !== decision || current.actorId !== actorId)) {
        throw Object.assign(new Error('Approval already has a different decision'), { code: 'APPROVAL_DECISION_CONFLICT' });
      }
      updated = current ? stored : { ...stored, decision: decisionRecord };
      this.approvals.set(approvalId, updated);
    }

    return {
      approvalId,
      executionId: updated.executionId,
      tenantId: updated.tenantId || tenantId || null,
      decision: { ...updated.decision },
      idempotent: Boolean(updated.decision?.decidedAt !== decisionRecord.decidedAt)
    };
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
