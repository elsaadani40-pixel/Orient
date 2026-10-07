const AppError = require('../../core/errors/AppError');
const {
  createMemory,
  normalizeMemory,
  clamp
} = require('../../domain/memory/memory.entity');

function tokenize(value) {
  return [...new Set(
    String(value || '')
      .toLowerCase()
      .normalize('NFKC')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(token => token.length > 1)
  )];
}

function lexicalScore(query, text) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return 0;
  const textTokens = new Set(tokenize(text));
  const matches = queryTokens.filter(token => textTokens.has(token)).length;
  return matches / queryTokens.length;
}

function recencyScore(memory, now = Date.now()) {
  const timestamp = Date.parse(
    memory.lastAccessedAt || memory.updatedAt || memory.createdAt
  );
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (now - timestamp) / 86400000);
  return Math.exp(-ageDays / 30);
}

function temporalScore(memory, now = new Date()) {
  const from = memory.validFrom ? Date.parse(memory.validFrom) : null;
  const until = memory.validUntil ? Date.parse(memory.validUntil) : null;
  const time = now.getTime();
  if (Number.isFinite(from) && time < from) return 0;
  if (Number.isFinite(until) && time > until) return 0;
  return 1;
}

function isTemporallyValid(memory, now = new Date()) {
  return temporalScore(memory, now) > 0;
}

const SOURCE_RELIABILITY = Object.freeze({
  user: 0.95,
  system: 0.9,
  agent: 0.8,
  external: 0.7,
  imported: 0.6,
  unknown: 0.4
});

function sourceReliability(source = {}) {
  return SOURCE_RELIABILITY[source.type] || SOURCE_RELIABILITY.unknown;
}

function evidenceStrength(memory) {
  if (!Array.isArray(memory.evidence) || !memory.evidence.length) return 0;
  const weighted = memory.evidence.map(item =>
    clamp(item.confidence, 0.5) * sourceReliability(item.source)
  );
  const mean = weighted.reduce((sum, value) => sum + value, 0) / weighted.length;
  const countBonus = Math.min(0.15, Math.log2(weighted.length + 1) * 0.05);
  return Math.min(1, mean + countBonus);
}

function verificationScore(memory) {
  if (!memory.verifiedAt) return 0;
  return Number.isFinite(Date.parse(memory.verifiedAt)) ? 1 : 0;
}

function conflictRecencyScore(memory, now = Date.now()) {
  const timestamp = Date.parse(memory.updatedAt || memory.createdAt || memory.verifiedAt);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (now - timestamp) / 86400000);
  return Math.exp(-ageDays / 90);
}

function conflictResolutionScore(memory, options = {}) {
  const normalized = normalizeMemory(memory);
  const nowDate = options.nowDate || new Date();
  const temporal = temporalScore(normalized, nowDate);
  const confidence = clamp(normalized.confidence, 0.5);
  const source = sourceReliability(normalized.source);
  const evidence = evidenceStrength(normalized);
  const verified = verificationScore(normalized);
  const recency = conflictRecencyScore(normalized, nowDate.getTime());
  const importance = clamp(normalized.importance, 0.5);

  if (temporal === 0) {
    return { score: 0, components: { temporal: 0, confidence, source, evidence, verified, recency, importance }, eligible: false };
  }

  const score =
    (confidence * 0.25) +
    (source * 0.20) +
    (evidence * 0.20) +
    (verified * 0.15) +
    (recency * 0.10) +
    (importance * 0.10);

  return {
    score: Number(score.toFixed(6)),
    components: { temporal, confidence, source, evidence, verified, recency, importance },
    eligible: true
  };
}

function compareConflictCandidates(left, right, options = {}) {
  const leftResult = conflictResolutionScore(left, options);
  const rightResult = conflictResolutionScore(right, options);

  if (leftResult.eligible !== rightResult.eligible) return leftResult.eligible ? left : right;
  if (leftResult.score !== rightResult.score) return leftResult.score > rightResult.score ? left : right;

  const leftVerified = Date.parse(left.verifiedAt || '') || 0;
  const rightVerified = Date.parse(right.verifiedAt || '') || 0;
  if (leftVerified !== rightVerified) return leftVerified > rightVerified ? left : right;

  const leftUpdated = Date.parse(left.updatedAt || left.createdAt || '') || 0;
  const rightUpdated = Date.parse(right.updatedAt || right.createdAt || '') || 0;
  if (leftUpdated !== rightUpdated) return leftUpdated > rightUpdated ? left : right;

  return left;
}

function relevanceScore(memory, query, options = {}) {
  const lexical = lexicalScore(query, memory.text);
  const recency = recencyScore(memory, options.now || Date.now());
  const importance = clamp(memory.importance, 0.5);
  const confidence = clamp(memory.confidence, 0.5);
  const temporal = temporalScore(memory, options.nowDate || new Date());
  const typeBoost = options.type && memory.type === options.type ? 0.15 : 0;

  return Math.min(
    1,
    (lexical * 0.45) +
    (recency * 0.15) +
    (importance * 0.15) +
    (confidence * 0.15) +
    (temporal * 0.10) +
    typeBoost
  );
}

class MemoryService {
  constructor(repository, {
    memoryAccessPolicy = null,
    defaultScope = 'personal',
    auditRepository = null
  } = {}) {
    if (!repository) throw new TypeError('repository is required');
    this.repository = repository;
    this.memoryAccessPolicy = memoryAccessPolicy;
    this.defaultScope = defaultScope;
    this.auditRepository = auditRepository;
  }

  resolveTenant(context = {}) {
    const tenantId = context.tenantId;
    if (!tenantId || typeof tenantId !== 'string') {
      throw new AppError(
        'Tenant identity is required for memory access',
        403,
        'MEMORY_TENANT_REQUIRED'
      );
    }
    if (context.runtimeTenantId && context.runtimeTenantId !== tenantId) {
      throw new AppError(
        'Memory tenant does not match canonical runtime tenant',
        403,
        'MEMORY_TENANT_CONTEXT_MISMATCH'
      );
    }
    return tenantId;
  }

  resolveScope(context = {}, requestedScope = null) {
    const scope = requestedScope || context.memoryScope || this.defaultScope;
    if (!scope || typeof scope !== 'string') {
      throw new AppError('Memory scope is required', 403, 'MEMORY_SCOPE_REQUIRED');
    }
    return scope;
  }

  authorize(context = {}, operation = 'read', scope = null) {
    const tenantId = this.resolveTenant(context);
    const resolvedScope = this.resolveScope(context, scope);
    if (!this.memoryAccessPolicy) {
      return {
        allowed: true,
        agentId: context.agentId || 'ORIENT_RUNTIME',
        scope: resolvedScope,
        operation,
        tenantId
      };
    }
    try {
      const decision = this.memoryAccessPolicy.authorize({
        agentId: context.agentId || 'ORIENT_RUNTIME',
        scope: resolvedScope,
        operation
      });
      return Object.freeze({ ...decision, tenantId });
    } catch (error) {
      throw new AppError(
        error.message,
        403,
        error.code || 'MEMORY_ACCESS_FORBIDDEN'
      );
    }
  }

  audit(event, context = {}) {
    if (!this.auditRepository) return null;
    return this.auditRepository.append({
      ...event,
      agentId: context.agentId || 'ORIENT_RUNTIME',
      scope: event.scope || context.memoryScope || this.defaultScope,
      executionId: event.executionId || context.executionId || null,
      goalId: event.goalId || context.goalId || null,
      decisionId: event.decisionId || context.decisionId || null,
      correlationId: event.correlationId || context.correlationId || null,
      traceId: event.traceId || context.traceId || null
    });
  }

  history(id, context = {}) {
    const authorization = this.authorize(context, 'read');
    if (!this.auditRepository || typeof this.auditRepository.findByMemoryId !== 'function') {
      return [];
    }
    return this.auditRepository.findByMemoryId(
      id,
      authorization.tenantId,
      authorization.scope
    );
  }

  findExact({ tenantId, scope, type, text }) {
    if (typeof this.repository.findByFingerprint === 'function') {
      return this.repository.findByFingerprint({ tenantId, scope, type, text });
    }
    return this.repository.findAll(tenantId, scope).find(memory =>
      memory.state !== 'archived' &&
      memory.type === type &&
      String(memory.text || '').trim().toLowerCase() === String(text || '').trim().toLowerCase()
    ) || null;
  }

  findConflict(semanticKey, tenantId, scope) {
    if (!semanticKey) return null;
    if (typeof this.repository.findActiveBySemanticKey === 'function') {
      return this.repository.findActiveBySemanticKey(semanticKey, tenantId, scope);
    }
    return this.repository.findAll(tenantId, scope).find(memory =>
      memory.state === 'active' &&
      memory.semanticKey === semanticKey
    ) || null;
  }

  list(query = '', context = {}, options = {}) {
    const authorization = this.authorize(context, 'read', options.scope);
    const memories = this.repository
      .findAll(authorization.tenantId, authorization.scope)
      .map(normalizeMemory)
      .filter(memory =>
        memory.state === 'active' &&
        (options.includeExpired ||
          isTemporallyValid(memory, options.nowDate || new Date()))
      );

    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) {
      return memories.sort(
        (a, b) => relevanceScore(b, '', options) - relevanceScore(a, '', options)
      );
    }

    return memories
      .map(memory => ({
        ...memory,
        relevance: relevanceScore(memory, cleanQuery, options)
      }))
      .filter(memory => memory.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance);
  }

  add(text, options = {}, context = {}) {
    const clean = String(text || '').trim();
    if (!clean) {
      throw new AppError('نص الذاكرة مطلوب', 400, 'MEMORY_TEXT_REQUIRED');
    }

    try {
      const authorization = this.authorize(context, 'write', options.scope);
      const tenantId = authorization.tenantId;
      const scope = authorization.scope;

      const candidate = createMemory({
        text: clean,
        type: options.type,
        importance: options.importance,
        confidence: options.confidence,
        source: options.source,
        semanticKey: options.semanticKey,
        validFrom: options.validFrom,
        validUntil: options.validUntil,
        verifiedAt: options.verifiedAt,
        tags: options.tags,
        evidence: options.evidence,
        tenantId,
        scope
      });

      const exact = this.findExact({
        tenantId,
        scope,
        type: candidate.type,
        text: candidate.text
      });

      if (exact) {
        const updated = this.repository.update(
          exact.id,
          {
            confidence: Math.max(exact.confidence, candidate.confidence),
            importance: Math.max(exact.importance, candidate.importance),
            updatedAt: new Date().toISOString(),
            evidence: [...exact.evidence, ...candidate.evidence].slice(-50),
            lastAccessedAt: exact.lastAccessedAt || null
          },
          tenantId,
          scope
        );

        this.audit({
          action: 'memory.reinforced',
          tenantId,
          memoryId: exact.id,
          evidence: candidate.evidence
        }, context);

        return updated;
      }

      const conflict = this.findConflict(
        candidate.semanticKey,
        tenantId,
        scope
      );

      let memory = candidate;

      if (conflict && conflict.text !== candidate.text) {
        const resolution = compareConflictCandidates(candidate, conflict);
        const candidateScore = conflictResolutionScore(candidate);
        const conflictScore = conflictResolutionScore(conflict);
        const candidateWins = resolution.id === candidate.id;

        if (candidateWins) {
          this.repository.update(conflict.id, {
            state: 'superseded',
            supersededById: candidate.id,
            updatedAt: new Date().toISOString()
          }, tenantId, scope);
          memory = { ...candidate, supersedesId: conflict.id };
        } else {
          memory = { ...candidate, state: 'contradicted', supersededById: null, supersedesId: null };
        }

        this.audit({
          action: 'memory.conflict.resolved',
          tenantId,
          memoryId: candidate.id,
          relatedMemoryId: conflict.id,
          resolution: candidateWins
            ? 'candidate_wins_evidence_policy'
            : 'existing_memory_wins_evidence_policy',
          rationale: {
            policy: 'confidence_source_evidence_verification_recency_importance',
            candidate: candidateScore,
            existing: conflictScore,
            winnerId: resolution.id
          }
        }, context);
      }

      const inserted = this.repository.insert(memory, tenantId, scope);

      this.audit({
        action: 'memory.created',
        tenantId,
        memoryId: inserted.id,
        source: inserted.source,
        confidence: inserted.confidence
      }, context);

      return inserted;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(error.message, 400, 'INVALID_MEMORY');
    }
  }

  get(id, context = {}) {
    const authorization = this.authorize(context, 'read');
    const memory = this.repository.findById(
      id,
      authorization.tenantId,
      authorization.scope
    );

    if (!memory || memory.state !== 'active') {
      throw new AppError('الذاكرة غير موجودة', 404, 'MEMORY_NOT_FOUND');
    }

    const normalized = normalizeMemory(memory);
    this.repository.update(
      id,
      {
        lastAccessedAt: new Date().toISOString(),
        accessCount: normalized.accessCount + 1
      },
      authorization.tenantId,
      authorization.scope
    );

    this.audit({
      action: 'memory.accessed',
      tenantId: authorization.tenantId,
      memoryId: id
    }, context);

    return normalized;
  }

  search(query, context = {}, options = {}) {
    return this.list(query, context, options);
  }

  consolidate(context = {}) {
    const authorization = this.authorize(context, 'write');
    const tenantId = authorization.tenantId;
    const scope = authorization.scope;
    const memories = this.repository
      .findAll(tenantId, scope)
      .map(normalizeMemory);

    const seen = new Map();
    const changes = [];

    for (const memory of memories) {
      if (memory.state !== 'active') continue;
      const key = `${memory.type}::${memory.text.toLowerCase().trim()}`;
      const previous = seen.get(key);

      if (!previous) {
        seen.set(key, memory);
        continue;
      }

      const winner =
        previous.confidence >= memory.confidence ? previous : memory;
      const loser = winner.id === previous.id ? memory : previous;

      this.repository.update(
        winner.id,
        {
          confidence: Math.max(winner.confidence, loser.confidence),
          importance: Math.max(winner.importance, loser.importance),
          evidence: [...winner.evidence, ...loser.evidence].slice(-50),
          updatedAt: new Date().toISOString()
        },
        tenantId,
        scope
      );

      this.repository.update(
        loser.id,
        {
          state: 'superseded',
          supersededById: winner.id,
          updatedAt: new Date().toISOString()
        },
        tenantId,
        scope
      );

      seen.set(key, winner);
      changes.push({ winnerId: winner.id, supersededId: loser.id });
    }

    this.audit({ action: 'memory.consolidated', tenantId, changes }, context);

    return { tenantId, scope, consolidated: changes.length, changes };
  }

  delete(id, context = {}) {
    const authorization = this.authorize(context, 'delete');
    const memory = this.repository.findById(
      id,
      authorization.tenantId,
      authorization.scope
    );

    if (!memory) {
      throw new AppError('الذاكرة غير موجودة', 404, 'MEMORY_NOT_FOUND');
    }

    this.repository.update(
      id,
      {
        state: 'archived',
        updatedAt: new Date().toISOString()
      },
      authorization.tenantId,
      authorization.scope
    );

    this.audit({
      action: 'memory.archived',
      tenantId: authorization.tenantId,
      memoryId: id,
      reason: context.reason || 'manual'
    }, context);

    return true;
  }

  forget(id, context = {}) {
    return this.delete(id, context);
  }

  count(context = {}) {
    const authorization = this.authorize(context, 'read');
    return this.repository.findAll(
      authorization.tenantId,
      authorization.scope
    ).length;
  }
}

module.exports = MemoryService;
module.exports.relevanceScore = relevanceScore;
module.exports.lexicalScore = lexicalScore;
module.exports.temporalScore = temporalScore;
module.exports.isTemporallyValid = isTemporallyValid;
module.exports.conflictResolutionScore = conflictResolutionScore;
module.exports.compareConflictCandidates = compareConflictCandidates;
