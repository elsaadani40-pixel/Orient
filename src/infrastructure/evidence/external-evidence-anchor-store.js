'use strict';

const { canonicalJson } = require('../../core/execution/evidence-record');
const { verifyEvidenceAnchor } = require('./trusted-evidence-cryptography');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function encodeScope(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function anchorKey(anchor) {
  return [
    'orient',
    'evidence-anchors',
    'v1',
    encodeScope(anchor.tenantId),
    encodeScope(anchor.executionId),
    String(anchor.sequence).padStart(16, '0')
  ].join('/');
}

function parseStoredAnchor(value) {
  if (typeof value !== 'string') fail('EVIDENCE_ANCHOR_STORE_CORRUPT', 'Stored anchor must be UTF-8 JSON text');
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('EVIDENCE_ANCHOR_STORE_CORRUPT', 'Stored anchor is not valid JSON');
  }
  let canonical;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    fail('EVIDENCE_ANCHOR_STORE_CORRUPT', 'Stored anchor cannot be canonicalized safely');
  }
  if (canonical !== value) {
    fail('EVIDENCE_ANCHOR_STORE_NON_CANONICAL', 'Stored anchor is not in canonical form');
  }
  return parsed;
}

/**
 * Adapter for an independently administered immutable object store.
 *
 * backend contract:
 *   putIfAbsent(key, value) -> { created: boolean, existingValue?: string }
 *   get(key) -> string | null
 *   list(prefix) -> Array<{ key: string, value: string }>
 *
 * The backend MUST provide strongly-consistent conditional creation and must
 * prevent overwrite/delete for the configured principal. This class cannot
 * make a mutable backend immutable or create a separate trust domain itself.
 */
class ExternalEvidenceAnchorStore {
  constructor({ backend, trustedAnchorKeys } = {}) {
    if (!backend || typeof backend.putIfAbsent !== 'function' ||
        typeof backend.get !== 'function' || typeof backend.list !== 'function') {
      throw new TypeError('An immutable external anchor backend is required');
    }
    if (!trustedAnchorKeys || typeof trustedAnchorKeys !== 'object') {
      throw new TypeError('Trusted external anchor public keys are required');
    }
    this.backend = backend;
    this.trustedAnchorKeys = trustedAnchorKeys;
  }

  async append(anchor) {
    if (!verifyEvidenceAnchor(anchor, this.trustedAnchorKeys)) {
      fail('EVIDENCE_ANCHOR_SIGNATURE_INVALID', 'Only a valid externally signed evidence anchor can be stored');
    }
    const key = anchorKey(anchor);
    const value = canonicalJson(anchor);
    const result = await this.backend.putIfAbsent(key, value);
    if (!result || typeof result.created !== 'boolean') {
      fail('EVIDENCE_ANCHOR_STORE_CONTRACT_INVALID', 'Backend putIfAbsent must return a created boolean');
    }
    if (result.created) return { created: true, anchor };
    const existingValue = typeof result.existingValue === 'string'
      ? result.existingValue
      : await this.backend.get(key);
    if (existingValue === null || existingValue === undefined) {
      fail('EVIDENCE_ANCHOR_STORE_RACE', 'Anchor exists but could not be read back');
    }
    const existing = parseStoredAnchor(existingValue);
    if (!verifyEvidenceAnchor(existing, this.trustedAnchorKeys) ||
        canonicalJson(existing) !== value) {
      fail('EVIDENCE_ANCHOR_CONFLICT', 'An immutable anchor already exists at this scope and sequence with different content');
    }
    return { created: false, anchor: existing };
  }

  async get({ tenantId, executionId, sequence } = {}) {
    if (typeof tenantId !== 'string' || !tenantId.trim() ||
        typeof executionId !== 'string' || !executionId.trim() ||
        !Number.isSafeInteger(sequence) || sequence < 1) {
      fail('EVIDENCE_ANCHOR_SCOPE_INVALID', 'Tenant, execution, and positive sequence are required');
    }
    const value = await this.backend.get(anchorKey({ tenantId, executionId, sequence }));
    if (value === null || value === undefined) return null;
    const anchor = parseStoredAnchor(value);
    if (anchor.tenantId !== tenantId || anchor.executionId !== executionId ||
        anchor.sequence !== sequence || !verifyEvidenceAnchor(anchor, this.trustedAnchorKeys)) {
      fail('EVIDENCE_ANCHOR_STORE_CORRUPT', 'Retrieved anchor failed scope or signature verification');
    }
    return anchor;
  }

  async list({ tenantId, executionId } = {}) {
    if (typeof tenantId !== 'string' || !tenantId.trim() ||
        typeof executionId !== 'string' || !executionId.trim()) {
      fail('EVIDENCE_ANCHOR_SCOPE_INVALID', 'Tenant and execution are required');
    }
    const prefix = [
      'orient',
      'evidence-anchors',
      'v1',
      encodeScope(tenantId),
      encodeScope(executionId),
      ''
    ].join('/');
    const entries = await this.backend.list(prefix);
    if (!Array.isArray(entries)) {
      fail('EVIDENCE_ANCHOR_STORE_CONTRACT_INVALID', 'Backend list must return an array');
    }
    const anchors = entries.map(entry => {
      if (!entry || typeof entry.key !== 'string' || !entry.key.startsWith(prefix)) {
        fail('EVIDENCE_ANCHOR_STORE_CORRUPT', 'Backend returned an anchor outside the requested scope');
      }
      const anchor = parseStoredAnchor(entry.value);
      if (anchor.tenantId !== tenantId || anchor.executionId !== executionId ||
          anchorKey(anchor) !== entry.key || !verifyEvidenceAnchor(anchor, this.trustedAnchorKeys)) {
        fail('EVIDENCE_ANCHOR_STORE_CORRUPT', 'Listed anchor failed key, scope, or signature verification');
      }
      return anchor;
    });
    anchors.sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < anchors.length; i += 1) {
      if (anchors[i - 1].sequence === anchors[i].sequence) {
        fail('EVIDENCE_ANCHOR_STORE_DUPLICATE', 'External store returned duplicate anchor sequences');
      }
    }
    return anchors;
  }
}

module.exports = { ExternalEvidenceAnchorStore, anchorKey };
