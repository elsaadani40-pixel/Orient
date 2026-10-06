const crypto = require('crypto');

const MEMORY_TYPES = Object.freeze([
  'fact',
  'preference',
  'person',
  'task',
  'note'
]);

const MEMORY_SCOPES = Object.freeze([
  'personal',
  'shared.memory',
  'shared.research'
]);

function createMemory({
  text,
  type = 'note',
  importance = 0.5,
  scope = 'personal'
} = {}) {
  const cleanText = String(text || '').trim();

  if (!cleanText) {
    throw new Error('Memory text cannot be empty');
  }

  if (cleanText.length > 10000) {
    throw new Error('Memory text is too long');
  }

  const normalizedType = MEMORY_TYPES.includes(type)
    ? type
    : 'note';

  const normalizedImportance = Math.min(
    1,
    Math.max(0, Number(importance) || 0.5)
  );

  const normalizedScope = MEMORY_SCOPES.includes(scope)
    ? scope
    : 'personal';

  const now = new Date().toISOString();

  const memory = {
    id: crypto.randomUUID(),
    text: cleanText,
    type: normalizedType,
    importance: normalizedImportance,
    createdAt: now,
    updatedAt: now
  };

  Object.defineProperty(memory, 'scope', {
    value: normalizedScope,
    enumerable: false,
    writable: false,
    configurable: false
  });

  return Object.freeze(memory);
}

function normalizeMemory(memory) {
  const now = new Date().toISOString();

  const normalized = {
    id: memory.id || crypto.randomUUID(),
    text: String(memory.text || '').trim(),
    type: MEMORY_TYPES.includes(memory.type)
      ? memory.type
      : 'note',
    importance:
      typeof memory.importance === 'number'
        ? Math.min(1, Math.max(0, memory.importance))
        : 0.5,
    createdAt: memory.createdAt || now,
    updatedAt: memory.updatedAt || memory.createdAt || now
  };

  Object.defineProperty(normalized, 'scope', {
    value: MEMORY_SCOPES.includes(memory.scope)
      ? memory.scope
      : 'personal',
    enumerable: false,
    writable: false,
    configurable: false
  });

  return normalized;
}

module.exports = {
  MEMORY_TYPES,
  MEMORY_SCOPES,
  createMemory,
  normalizeMemory
};
