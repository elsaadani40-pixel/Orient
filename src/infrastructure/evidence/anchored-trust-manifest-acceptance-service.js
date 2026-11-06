'use strict';

const { canonicalJson } = require('../../core/execution/evidence-record');
const { verifyTrustManifest, verifyAndAcceptTrustManifest } = require('./trusted-evidence-trust-manifest');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

/**
 * Coordinates an independently immutable manifest history with the local
 * monotonic version cache. The external history is authoritative on recovery.
 */
class AnchoredTrustManifestAcceptanceService {
  constructor({
    trustedRootKeys,
    versionStore,
    externalAnchorStore,
    authorize,
    maxManifestBytes = 256 * 1024,
    now = () => new Date().toISOString()
  } = {}) {
    if (!trustedRootKeys || typeof trustedRootKeys !== 'object') {
      throw new TypeError('Pinned trust-manifest root public keys are required');
    }
    if (!versionStore || typeof versionStore.read !== 'function' ||
        typeof versionStore.compareAndSet !== 'function') {
      throw new TypeError('An independent durable trust-state cache is required');
    }
    if (!externalAnchorStore || typeof externalAnchorStore.readHead !== 'function' ||
        typeof externalAnchorStore.append !== 'function') {
      throw new TypeError('An independently administered immutable trust history is required');
    }
    if (typeof authorize !== 'function') {
      throw new TypeError('A host-provided authenticated principal authorizer is required');
    }
    if (!Number.isSafeInteger(maxManifestBytes) || maxManifestBytes < 1024 ||
        maxManifestBytes > 1024 * 1024) {
      throw new TypeError('maxManifestBytes must be between 1 KiB and 1 MiB');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a clock function');
    this.trustedRootKeys = trustedRootKeys;
    this.versionStore = versionStore;
    this.externalAnchorStore = externalAnchorStore;
    this.authorize = authorize;
    this.maxManifestBytes = maxManifestBytes;
    this.now = now;
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

    const now = this.now();
    const verified = verifyTrustManifest(manifest, this.trustedRootKeys, { verificationTime: now });
    if (!verified) {
      fail('EVIDENCE_TRUST_MANIFEST_SIGNATURE_INVALID', 'Trust manifest signature or validity is invalid');
    }

    const externalHead = await this.externalAnchorStore.readHead();
    if (externalHead && verified.version === externalHead.version) {
      if (verified.digest !== externalHead.digest) {
        fail('EVIDENCE_TRUST_MANIFEST_VERSION_CONFLICT', 'Manifest conflicts with the independently anchored trust head');
      }
      // Exact head replay is the only permitted recovery path after local cache loss.
    } else {
      const expectedNextVersion = (externalHead?.version || 0) + 1;
      if (verified.version < expectedNextVersion) {
        fail('EVIDENCE_TRUST_MANIFEST_ROLLBACK', 'Manifest is older than the independently anchored trust head');
      }
      if (verified.version > expectedNextVersion) {
        fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_GAP', 'Manifest skips an independently anchored trust version');
      }
      await this.externalAnchorStore.append(manifest, { verificationTime: now });
    }

    const accepted = await verifyAndAcceptTrustManifest(manifest, {
      trustedRootKeys: this.trustedRootKeys,
      versionStore: this.versionStore,
      now
    });
    return Object.freeze({
      version: accepted.version,
      digest: accepted.digest,
      accepted: true,
      externallyAnchored: true
    });
  }
}

module.exports = { AnchoredTrustManifestAcceptanceService };
