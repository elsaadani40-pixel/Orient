'use strict';

const { canonicalJson } = require('../../core/execution/evidence-record');
const { verifyTrustManifest } = require('./trusted-evidence-trust-manifest');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function manifestKey(version) {
  if (!Number.isSafeInteger(version) || version < 1) {
    fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_INVALID', 'A positive manifest version is required');
  }
  return `orient/trust-manifests/v1/${String(version).padStart(16, '0')}.json`;
}

function parseManifest(value) {
  if (typeof value !== 'string') {
    fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_CORRUPT', 'Stored manifest must be UTF-8 JSON text');
  }
  let manifest;
  try {
    manifest = JSON.parse(value);
    if (canonicalJson(manifest) !== value) throw new Error('non-canonical');
  } catch {
    fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_CORRUPT', 'Stored manifest is malformed or non-canonical');
  }
  return manifest;
}

/**
 * Immutable external acceptance ledger for root-signed trust manifests.
 *
 * The backend must provide strongly consistent putIfAbsent/get/list operations
 * and deny overwrite/delete to this adapter's principal. It must be operated
 * in a trust domain independent from ORIENT Runtime and the PostgreSQL cache.
 * This adapter cannot create those provider-side guarantees.
 */
class ExternalTrustManifestAnchorStore {
  constructor({ backend, trustedRootKeys } = {}) {
    if (!backend || typeof backend.putIfAbsent !== 'function' ||
        typeof backend.get !== 'function' || typeof backend.list !== 'function') {
      throw new TypeError('An immutable external trust-manifest backend is required');
    }
    if (!trustedRootKeys || typeof trustedRootKeys !== 'object') {
      throw new TypeError('Pinned trust-manifest root public keys are required');
    }
    this.backend = backend;
    this.trustedRootKeys = trustedRootKeys;
  }

  async readHead() {
    const entries = await this.backend.list('orient/trust-manifests/v1/');
    if (!Array.isArray(entries)) {
      fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_CONTRACT_INVALID', 'Backend list must return an array');
    }
    const manifests = entries.map(entry => {
      if (!entry || typeof entry.key !== 'string' ||
          !entry.key.startsWith('orient/trust-manifests/v1/')) {
        fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_CORRUPT', 'Backend returned an entry outside the trust-manifest namespace');
      }
      const manifest = parseManifest(entry.value);
      if (manifestKey(manifest.version) !== entry.key ||
          !verifyTrustManifest(manifest, this.trustedRootKeys)) {
        fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_CORRUPT', 'Stored trust manifest failed key or signature verification');
      }
      return manifest;
    }).sort((a, b) => a.version - b.version);

    for (let i = 0; i < manifests.length; i += 1) {
      if (manifests[i].version !== i + 1) {
        fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_GAP', 'External trust history is incomplete; refusing to infer a trusted head');
      }
      if (i > 0 && manifests[i].issuedAt < manifests[i - 1].issuedAt) {
        fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_ORDER_INVALID', 'Trust-manifest issuance timestamps must not move backwards');
      }
    }
    const head = manifests.at(-1) || null;
    if (!head) return null;
    const verified = verifyTrustManifest(head, this.trustedRootKeys);
    return Object.freeze({ version: verified.version, digest: verified.digest });
  }

  async append(manifest, { verificationTime = new Date().toISOString() } = {}) {
    const verified = verifyTrustManifest(manifest, this.trustedRootKeys, { verificationTime });
    if (!verified) {
      fail('EVIDENCE_TRUST_MANIFEST_SIGNATURE_INVALID', 'Only a currently valid root-signed manifest can be anchored');
    }
    const head = await this.readHead();
    if (head && verified.version === head.version) {
      if (verified.digest !== head.digest) {
        fail('EVIDENCE_TRUST_MANIFEST_VERSION_CONFLICT', 'An immutable external anchor already binds this version to different content');
      }
      return { created: false, ...head };
    }
    if (verified.version !== (head?.version || 0) + 1) {
      fail('EVIDENCE_TRUST_MANIFEST_ROLLBACK', 'External trust history accepts only the next sequential manifest version');
    }

    const key = manifestKey(verified.version);
    const value = canonicalJson(manifest);
    const result = await this.backend.putIfAbsent(key, value);
    if (!result || typeof result.created !== 'boolean') {
      fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_CONTRACT_INVALID', 'Backend putIfAbsent must return a created boolean');
    }
    if (result.created) return { created: true, version: verified.version, digest: verified.digest };

    const existingValue = typeof result.existingValue === 'string'
      ? result.existingValue
      : await this.backend.get(key);
    if (existingValue === null || existingValue === undefined) {
      fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_RACE', 'Existing external anchor could not be read back');
    }
    const existing = parseManifest(existingValue);
    const existingVerified = verifyTrustManifest(existing, this.trustedRootKeys);
    if (!existingVerified || existingVerified.digest !== verified.digest) {
      fail('EVIDENCE_TRUST_MANIFEST_VERSION_CONFLICT', 'An immutable external anchor already binds this version to different content');
    }
    return { created: false, version: verified.version, digest: verified.digest };
  }
}

module.exports = { ExternalTrustManifestAnchorStore, manifestKey };
