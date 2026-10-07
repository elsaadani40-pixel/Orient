const crypto = require('crypto');

const MEMORY_TYPES = Object.freeze([
  'fact',
  'preference',
  'person',
  'event',
  'task',
  'note'
]);

const SOURCE_TYPES = Object.freeze([
  'user',
  'agent',
  'external',
  'system',
  'imported',
  'unknown'
]);

const MEMORY_STATES = Object.freeze([
  'active',
  'superseded',
  'contradicted',
  'expired',
  'archived'
]);

function clamp(value, fallback = 0.5) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(1, Math.max(0, number))
    : fallback;
}

function normalizeSource(source = {}) {
  const sourceType = SOURCE_TYPES.includes(source.type)
    ? source.type
    : 'unknown';

  return {
    type: sourceType,
    id: source.id || null,
    ref: source.ref || null,
    label: source.label || null
  };
}

function normalizeEvidence(evidence = {}, fallbackSource = {}) {
  return {
    id: evidence.id || crypto.randomUUID(),
    kind: evidence.kind || 'observation',
    source: normalizeSource(evidence.source || fallbackSource),
    capturedAt: evidence.capturedAt || new Date().toISOString(),
    confidence: clamp(evidence.confidence, 0.5),
    note: evidence.note || null
  };
}

function createMemory({
  text,
  type = 'note',
  importance = 0.5,
  confidence = 0.5,
  source = {},
  semanticKey = null,
  validFrom = null,
  validUntil = null,
  verifiedAt = null,
  tags = [],
  evidence = [],
  tenantId = 'default',
  scope = 'personal'
} = {}) {
  const cleanText = String(text || '').trim();

  if (!cleanText) {
    throw new Error('Memory text cannot be empty');
  }

  if (cleanText.length > 10000) {
    throw new Error('Memory text is too long');
  }

  const normalizedType = MEMORY_TYPES.includes(type) ? type : 'note';
  const normalizedSource = normalizeSource(source);
  const now = new Date().toISOString();
  const normalizedTags = Array.isArray(tags)
    ? [...new Set(tags.map(String).map(tag => tag.trim()).filter(Boolean))].slice(0, 50)
    : [];

  const record = {
    id: crypto.randomUUID(),
    tenantId: String(tenantId || 'default'),
    scope: String(scope || 'personal'),
    text: cleanText,
    type: normalizedType,
    semanticKey: semanticKey ? String(semanticKey).trim() : null,
    importance: clamp(importance, 0.5),
    confidence: clamp(confidence, 0.5),
    state: 'active',
    source: normalizedSource,
    validFrom,
    validUntil,
    verifiedAt,
    tags: normalizedTags,
    evidence: evidence.map(item => normalizeEvidence(item, normalizedSource)).slice(-50),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    accessCount: 0,
    supersedesId: null,
    supersededById: null
  };

  return Object.freeze(record);
}

function normalizeMemory(memory = {}) {
  const now = new Date().toISOString();
  const source = normalizeSource(memory.source || {});
  const evidence = Array.isArray(memory.evidence)
    ? memory.evidence.map(item => normalizeEvidence(item, source)).slice(-50)
    : [];

  return {
    id: memory.id || crypto.randomUUID(),
    tenantId: String(memory.tenantId || 'default'),
    scope: String(memory.scope || 'personal'),
    text: String(memory.text || '').trim(),
    type: MEMORY_TYPES.includes(memory.type) ? memory.type : 'note',
    semanticKey: memory.semanticKey ? String(memory.semanticKey).trim() : null,
    importance: clamp(memory.importance, 0.5),
    confidence: clamp(memory.confidence, 0.5),
    state: MEMORY_STATES.includes(memory.state) ? memory.state : 'active',
    source,
    validFrom: memory.validFrom || null,
    validUntil: memory.validUntil || null,
    verifiedAt: memory.verifiedAt || null,
    tags: Array.isArray(memory.tags)
      ? [...new Set(memory.tags.map(String).map(tag => tag.trim()).filter(Boolean))].slice(0, 50)
      : [],
    evidence,
    createdAt: memory.createdAt || now,
    updatedAt: memory.updatedAt || memory.createdAt || now,
    lastAccessedAt: memory.lastAccessedAt || null,
    accessCount: Number.isInteger(memory.accessCount) && memory.accessCount >= 0
      ? memory.accessCount
      : 0,
    supersedesId: memory.supersedesId || null,
    supersededById: memory.supersededById || null
  };
}

module.exports = {
  MEMORY_TYPES,
  SOURCE_TYPES,
  MEMORY_STATES,
  clamp,
  normalizeSource,
  normalizeEvidence,
  createMemory,
  normalizeMemory
};
