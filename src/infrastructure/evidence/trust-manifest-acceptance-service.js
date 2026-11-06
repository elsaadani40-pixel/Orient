'use strict';

const { canonicalJson } = require('../../core/execution/evidence-record');
const { verifyAndAcceptTrustManifest } = require('./trusted-evidence-trust-manifest');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

class TrustManifestAcceptanceService {
  constructor({
    trustedRootKeys,
    versionStore,
    authorize,
    maxManifestBytes = 256 * 1024
  } = {}) {
    if (!trustedRootKeys || typeof trustedRootKeys !== 'object') {
      throw new TypeError('Pinned trust-manifest root public keys are required');
    }
    if (!versionStore || typeof versionStore.read !== 'function' ||
        typeof versionStore.compareAndSet !== 'function') {
      throw new TypeError('An independent durable trust-state store is required');
    }
    if (typeof authorize !== 'function') {
      throw new TypeError('A host-provided authenticated principal authorizer is required');
    }
    if (!Number.isSafeInteger(maxManifestBytes) || maxManifestBytes < 1024 ||
        maxManifestBytes > 1024 * 1024) {
      throw new TypeError('maxManifestBytes must be between 1 KiB and 1 MiB');
    }
    this.trustedRootKeys = trustedRootKeys;
    this.versionStore = versionStore;
    this.authorize = authorize;
    this.maxManifestBytes = maxManifestBytes;
  }

  async accept({ manifest, principal } = {}) {
    let authorized = false;
    try {
      authorized = await this.authorize(principal, 'trust-manifest.accept');
    } catch {
      fail('EVIDENCE_TRUST_MANIFEST_AUTHORIZATION_FAILED', 'Trust manifest authorization could not be established');
    }
    if (authorized !== true) {
      fail('EVIDENCE_TRUST_MANIFEST_FORBIDDEN', 'Principal is not authorized to update trust state');
    }

    let serialized;
    try {
      serialized = canonicalJson(manifest);
    } catch {
      fail('EVIDENCE_TRUST_MANIFEST_INVALID', 'Trust manifest must be safely canonicalizable JSON data');
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.maxManifestBytes) {
      fail('EVIDENCE_TRUST_MANIFEST_TOO_LARGE', 'Trust manifest exceeds the configured size limit');
    }

    const accepted = await verifyAndAcceptTrustManifest(manifest, {
      trustedRootKeys: this.trustedRootKeys,
      versionStore: this.versionStore
    });
    return Object.freeze({
      version: accepted.version,
      digest: accepted.digest,
      accepted: true
    });
  }
}

module.exports = { TrustManifestAcceptanceService };
