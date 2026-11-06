'use strict';

const crypto = require('node:crypto');

const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;

function canonicalJson(value, depth = 0, ancestors = new Set()) {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError('Evidence payload exceeds the maximum nesting depth');
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Evidence payload contains a non-finite number');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Evidence payload contains a circular reference');
    }
    ancestors.add(value);
    const result = '[' + value.map(item =>
      canonicalJson(item, depth + 1, ancestors)
    ).join(',') + ']';
    ancestors.delete(value);
    return result;
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Evidence payload must contain plain JSON objects');
    }
    if (ancestors.has(value)) {
      throw new TypeError('Evidence payload contains a circular reference');
    }
    ancestors.add(value);
    const keys = Object.keys(value).sort();
    const fields = keys.map(key => {
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw new TypeError('Evidence payload contains a non-JSON value');
      }
      return JSON.stringify(key) + ':' + canonicalJson(item, depth + 1, ancestors);
    });
    ancestors.delete(value);
    return '{' + fields.join(',') + '}';
  }

  throw new TypeError('Evidence payload contains a non-JSON value');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
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
    if (Buffer.byteLength(canonicalResult, 'utf8') > MAX_CANONICAL_BYTES) {
      throw new TypeError('Evidence result exceeds the maximum canonical size');
    }
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
  createEvidenceRecord
};
