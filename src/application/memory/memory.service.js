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
  const timestamp = Date.parse(memory.lastAccessedAt || memory.updatedAt || memory.createdAt);
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
  constructor(repository, auditRepository = null) {
    if (!repository) {
      throw new TypeError('repository is required');
    }

    this.repository = repository;
    this.auditRepository = auditRepository;
  }

  audit(event) {
    if (!this.auditRepository) return null;
    return this.auditRepository.append(event);
  }

  list(query = '', options = {}) {
    const tenantId = String(options.tenantId || 'default');
    const memories = this.repository
      .findAll({ tenantId })
      .map(normalizeMemory)
      .filter(memory =>
        memory.state === 'active' &&
        (options.includeExpired || isTemporallyValid(memory, options.nowDate || new Date()))
      );

    const cleanQuery = String(query || '').trim();

    if (!cleanQuery) {
      return memories.sort((a, b) => {
        const scoreA = relevanceScore(a, '', options);
        const scoreB = relevanceScore(b, '', options);
        return scoreB - scoreA;
      });
    }

    return memories
      .map(memory => ({
        ...memory,
        relevance: relevanceScore(memory, cleanQuery, options)
      }))
      .filter(memory => memory.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance);
  }

  add(text, options = {}) {
    const clean = String(text || '').trim();
    if (!clean) {
      throw new AppError('نص الذاكرة مطلوب', 400, 'MEMORY_TEXT_REQUIRED');
    }

    try {
      const tenantId = String(options.tenantId || 'default');
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
        tenantId
      });

      const exact = this.repository.findByFingerprint({
        tenantId,
        type: candidate.type,
        text: candidate.text
      });

      if (exact) {
        const updated = this.repository.update(exact.id, {
          confidence: Math.max(exact.confidence, candidate.confidence),
          importance: Math.max(exact.importance, candidate.importance),
          updatedAt: new Date().toISOString(),
          evidence: [...exact.evidence, ...candidate.evidence].slice(-50),
          lastAccessedAt: exact.lastAccessedAt || null
        });

        this.audit({
          action: 'memory.reinforced',
          tenantId,
          memoryId: exact.id,
          evidence: candidate.evidence
        });

        return updated;
      }

      const conflict = candidate.semanticKey
        ? this.repository.findActiveBySemanticKey(candidate.semanticKey, tenantId)
        : null;

      let memory = candidate;

      if (conflict && conflict.text !== candidate.text) {
        this.repository.update(conflict.id, {
          state: 'superseded',
          supersededById: candidate.id,
          updatedAt: new Date().toISOString()
        });

        memory = {
          ...candidate,
          supersedesId: conflict.id
        };

        this.audit({
          action: 'memory.conflict_resolved',
          tenantId,
          memoryId: candidate.id,
          relatedMemoryId: conflict.id,
          resolution: 'newer_candidate_supersedes_previous'
        });
      }

      const inserted = this.repository.insert(memory);

      this.audit({
        action: 'memory.created',
        tenantId,
        memoryId: inserted.id,
        source: inserted.source,
        confidence: inserted.confidence
      });

      return inserted;
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        error.message,
        400,
        'INVALID_MEMORY'
      );
    }
  }

  get(id, options = {}) {
    const tenantId = String(options.tenantId || 'default');
    const memory = this.repository.findById(id, tenantId);

    if (!memory) {
      throw new AppError('الذاكرة غير موجودة', 404, 'MEMORY_NOT_FOUND');
    }

    const normalized = normalizeMemory(memory);

    if (normalized.state !== 'active') {
      throw new AppError('الذاكرة غير موجودة', 404, 'MEMORY_NOT_FOUND');
    }

    this.repository.update(id, {
      lastAccessedAt: new Date().toISOString(),
      accessCount: normalized.accessCount + 1
    });

    this.audit({
      action: 'memory.accessed',
      tenantId,
      memoryId: id
    });

    return normalized;
  }

  search(query, options = {}) {
    return this.list(query, options);
  }

  consolidate(options = {}) {
    const tenantId = String(options.tenantId || 'default');
    const memories = this.repository.findAll({ tenantId }).map(normalizeMemory);
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

      const winner = previous.confidence >= memory.confidence ? previous : memory;
      const loser = winner.id === previous.id ? memory : previous;

      this.repository.update(winner.id, {
        confidence: Math.max(winner.confidence, loser.confidence),
        importance: Math.max(winner.importance, loser.importance),
        evidence: [...winner.evidence, ...loser.evidence].slice(-50),
        updatedAt: new Date().toISOString()
      });

      this.repository.update(loser.id, {
        state: 'superseded',
        supersededById: winner.id,
        updatedAt: new Date().toISOString()
      });

      seen.set(key, winner);
      changes.push({
        winnerId: winner.id,
        supersededId: loser.id
      });
    }

    this.audit({
      action: 'memory.consolidated',
      tenantId,
      changes
    });

    return {
      tenantId,
      consolidated: changes.length,
      changes
    };
  }

  forget(id, options = {}) {
    const tenantId = String(options.tenantId || 'default');
    const memory = this.repository.findById(id, tenantId);

    if (!memory) {
      throw new AppError('الذاكرة غير موجودة', 404, 'MEMORY_NOT_FOUND');
    }

    this.repository.update(id, {
      state: 'archived',
      updatedAt: new Date().toISOString()
    });

    this.audit({
      action: 'memory.archived',
      tenantId,
      memoryId: id,
      reason: options.reason || 'manual'
    });

    return true;
  }
}

module.exports = MemoryService;
module.exports.relevanceScore = relevanceScore;
module.exports.lexicalScore = lexicalScore;
module.exports.temporalScore = temporalScore;
module.exports.isTemporallyValid = isTemporallyValid;
