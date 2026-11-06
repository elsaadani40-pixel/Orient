'use strict';

const crypto = require('node:crypto');

const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;

function canonicalJson(value) {
  const chunks = [];
  const ancestors = new Set();
  let byteLength = 0;

  function append(part) {
    byteLength += Buffer.byteLength(part, 'utf8');
    if (byteLength > MAX_CANONICAL_BYTES) {
      throw new TypeError('Evidence payload exceeds the maximum canonical size');
    }
    chunks.push(part);
  }

  function visit(item, depth) {
    if (depth > MAX_CANONICAL_DEPTH) {
      throw new TypeError('Evidence payload exceeds the maximum nesting depth');
    }

    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      append(JSON.stringify(item));
      return;
    }

    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new TypeError('Evidence payload contains a non-finite number');
      }
      append(JSON.stringify(item));
      return;
    }

    if (!item || typeof item !== 'object') {
      throw new TypeError('Evidence payload contains a non-JSON value');
    }

    if (ancestors.has(item)) {
      throw new TypeError('Evidence payload contains a circular reference');
    }

    const isArray = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Evidence payload must contain plain JSON objects');
    }

    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some(key => typeof key === 'symbol')) {
        throw new TypeError('Evidence payload cannot contain symbol keys');
      }

      if (isArray) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new TypeError('Evidence array has an invalid length');
        }
        const expectedKeys = new Set(['length']);
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          expectedKeys.add(key);
          const descriptor = descriptors[key];
          if (!descriptor) {
            throw new TypeError('Evidence payload cannot contain sparse arrays');
          }
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('Evidence payload cannot contain array accessors or hidden values');
          }
        }
        if (ownKeys.some(key => !expectedKeys.has(key))) {
          throw new TypeError('Evidence arrays cannot contain extra properties');
        }

        append('[');
        for (let index = 0; index < length; index += 1) {
          if (index > 0) append(',');
          visit(descriptors[String(index)].value, depth + 1);
        }
        append(']');
        return;
      }

      const keys = ownKeys.sort();
      const entries = [];
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Evidence payload cannot contain accessors or hidden values');
        }
        entries.push([key, descriptor.value]);
      }

      append('{');
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) append(',');
        append(JSON.stringify(entries[index][0]));
        append(':');
        visit(entries[index][1], depth + 1);
      }
      append('}');
    } finally {
      ancestors.delete(item);
    }
  }

  visit(value, 0);
  return chunks.join('');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function verifyEvidenceRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return false;
  }
  if (typeof record.id !== 'string' || !/^ev_[a-f0-9]{64}$/.test(record.id)) {
    return false;
  }

  const { id, ...identity } = record;
  try {
    return id === 'ev_' + sha256(canonicalJson(identity));
  } catch {
    return false;
  }
}

function createEvidenceRecord({
  executionId,
  step,
  tool,
  success,
  result = null,
  error = null,
  observedAt = new Date().toISOString(),
  links = []
} = {}) {
  if (typeof executionId !== 'string' || executionId.length === 0) {
    throw new TypeError('executionId is required for evidence');
  }
  if (!Number.isInteger(step) || step < 1) {
    throw new TypeError('step must be a positive integer for evidence');
  }
  if (typeof tool !== 'string' || tool.trim().length === 0) {
    throw new TypeError('tool is required for evidence');
  }
  if (typeof success !== 'boolean') {
    throw new TypeError('success must be a boolean for evidence');
  }
  if (!Array.isArray(links) || links.some(link => typeof link !== 'string' || !link.trim())) {
    throw new TypeError('evidence links must be non-empty strings');
  }
  const timestamp = new Date(observedAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError('observedAt must be a valid timestamp');
  }

  let resultSha256 = null;
  const limitations = [];
  try {
    const canonicalResult = canonicalJson(result);
    resultSha256 = sha256(canonicalResult);
  } catch (cause) {
    limitations.push(Object.freeze({
      code: 'result_digest_unavailable',
      message: cause.message
    }));
  }

  const record = {
    schemaVersion: 1,
    executionId,
    step,
    operation: tool,
    outcome: success ? 'success' : 'failure',
    confidence: 'observed',
    authority: 'our_run',
    observedAt: timestamp.toISOString(),
    environment: {
      runtime: 'node',
      runtimeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch
    },
    resultSha256,
    errorCode: error && typeof error.code === 'string'
      ? error.code.slice(0, 128)
      : null,
    coverage: { status: 'unknown' },
    limitations,
    links: [...links]
  };

  const identity = canonicalJson(record);
  record.id = 'ev_' + sha256(identity);

  Object.freeze(record.environment);
  Object.freeze(record.coverage);
  Object.freeze(record.limitations);
  Object.freeze(record.links);
  return Object.freeze(record);
}

module.exports = {
  canonicalJson,
  createEvidenceRecord,
  verifyEvidenceRecord
};
