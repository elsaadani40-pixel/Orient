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
  constructor({ expectedRetentionDays, commands, ...options } = {}) {
    if (!commands ||
        typeof commands.GetObjectLockConfigurationCommand !== 'function' ||
        typeof commands.GetBucketVersioningCommand !== 'function') {
      throw new TypeError('S3 Object Lock configuration and bucket-versioning commands are required');
    }
    if (!Number.isSafeInteger(expectedRetentionDays) || expectedRetentionDays < 1) {
      throw new TypeError('The expected bucket COMPLIANCE retention in days is required');
    }
    super({
      ...options,
      commands,
      namespacePrefix: 'orient/trust-manifests/v1/',
      useBucketDefaultRetention: true
    });
    this.expectedRetentionDays = expectedRetentionDays;
  }

  async verifyConfiguration() {
    // Bucket defaults can be changed by an independently administered S3
    // operator while this process remains alive. Re-read the control-plane
    // configuration for every operation instead of trusting a startup cache.
    const [lock, versioning] = await Promise.all([
      this.client.send(new this.commands.GetObjectLockConfigurationCommand({
        Bucket: this.bucket
      })),
      this.client.send(new this.commands.GetBucketVersioningCommand({
        Bucket: this.bucket
      }))
    ]);
    const retention = lock?.ObjectLockConfiguration?.Rule?.DefaultRetention;
    if (lock?.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled' ||
        retention?.Mode !== 'COMPLIANCE' ||
        retention?.Days !== this.expectedRetentionDays ||
        versioning?.Status !== 'Enabled') {
      throw Object.assign(
        new Error('S3 trust bucket must have versioning and the expected default COMPLIANCE retention'),
        { code: 'EVIDENCE_TRUST_MANIFEST_S3_CONFIGURATION_INVALID' }
      );
    }
    return Object.freeze({
      objectLockEnabled: true,
      versioningEnabled: true,
      retentionMode: 'COMPLIANCE',
      retentionDays: retention.Days
    });
  }

  async putIfAbsent(key, value) {
    await this.verifyConfiguration();
    return super.putIfAbsent(key, value);
  }

  async get(key) {
    await this.verifyConfiguration();
    return super.get(key);
  }

  async list(prefix) {
    await this.verifyConfiguration();
    return super.list(prefix);
  }
}

module.exports = { S3ObjectLockTrustManifestAnchorBackend };
