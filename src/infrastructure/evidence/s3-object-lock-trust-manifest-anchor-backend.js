'use strict';

const {
  S3ObjectLockEvidenceAnchorBackend
} = require('./s3-object-lock-evidence-anchor-backend');

/**
 * S3 Object Lock backend for ExternalTrustManifestAnchorStore.
 *
 * Uses a dedicated namespace and the same conditional-create, compliance
 * retention, bounded-read, and pagination guarantees as the evidence-anchor
 * backend. AWS SDK v3 remains host-injected; no cloud SDK enters the core.
 */
class S3ObjectLockTrustManifestAnchorBackend extends S3ObjectLockEvidenceAnchorBackend {
  constructor(options = {}) {
    super({
      ...options,
      namespacePrefix: 'orient/trust-manifests/v1/',
      useBucketDefaultRetention: true
    });
  }
}

module.exports = { S3ObjectLockTrustManifestAnchorBackend };
