'use strict';

const { AnchoredTrustManifestAcceptanceService } = require('./anchored-trust-manifest-acceptance-service');

/**
 * Public acceptance facade. An independent immutable history is mandatory;
 * the unanchored PostgreSQL-only acceptance path is intentionally unavailable.
 */
class TrustManifestAcceptanceService {
  constructor({
    trustedRootKeys,
    rootTransitionLedger,
    versionStore,
    externalAnchorStore,
    authorize,
    maxManifestBytes = 256 * 1024,
    now = () => new Date().toISOString()
  } = {}) {
    this.anchoredService = new AnchoredTrustManifestAcceptanceService({
      trustedRootKeys,
      rootTransitionLedger,
      versionStore,
      externalAnchorStore,
      authorize,
      maxManifestBytes,
      now
    });
  }

  async accept(input) {
    const accepted = await this.anchoredService.accept(input);
    return Object.freeze({
      version: accepted.version,
      digest: accepted.digest,
      accepted: true
    });
  }

  async recover(input) {
    return this.anchoredService.recover(input);
  }
}

module.exports = { TrustManifestAcceptanceService };
