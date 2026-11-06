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
    rootTransitionLedger,
    versionStore,
    externalAnchorStore,
    authorize,
    maxManifestBytes = 256 * 1024,
    now = () => new Date().toISOString()
  } = {}) {
    if ((!trustedRootKeys || typeof trustedRootKeys !== 'object') &&
        (!rootTransitionLedger || typeof rootTransitionLedger.readState !== 'function')) {
      throw new TypeError('Pinned root public keys or a verified root-transition ledger are required');
    }
    if (rootTransitionLedger !== undefined &&
        (!rootTransitionLedger || typeof rootTransitionLedger.readState !== 'function')) {
      throw new TypeError('rootTransitionLedger must expose readState()');
    }
    if (!versionStore || typeof versionStore.read !== 'function' ||
        typeof versionStore.compareAndSet !== 'function') {
      throw new TypeError('An independent durable trust-state cache is required');
    }
    if (!externalAnchorStore || typeof externalAnchorStore.readHead !== 'function' ||
        typeof externalAnchorStore.append !== 'function' ||
        (rootTransitionLedger && typeof externalAnchorStore.getManifest !== 'function')) {
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
    this.trustedRootKeys = trustedRootKeys || null;
    this.rootTransitionLedger = rootTransitionLedger || null;
    this.versionStore = versionStore;
    this.externalAnchorStore = externalAnchorStore;
    this.authorize = authorize;
    this.maxManifestBytes = maxManifestBytes;
    this.now = now;
  }

  async resolveTrustContext() {
    if (!this.rootTransitionLedger) {
      return { trustedRootKeys: this.trustedRootKeys, rootState: null };
    }
    let state;
    try {
      state = await this.rootTransitionLedger.readState();
    } catch {
      fail('EVIDENCE_TRUST_ROOT_STATE_UNAVAILABLE', 'Verified root-transition history could not be reconstructed');
    }
    if (!state || !state.trustedRootKeys || typeof state.trustedRootKeys !== 'object' ||
        typeof state.rootKeyId !== 'string' || !Number.isSafeInteger(state.manifestHeadVersion) ||
        !/^[a-f0-9]{64}$/.test(state.manifestHeadDigest || '')) {
      fail('EVIDENCE_TRUST_ROOT_STATE_INVALID', 'Root-transition ledger returned an invalid active trust state');
    }
    return { trustedRootKeys: state.trustedRootKeys, rootState: state };
  }

  async verifyExternalHeadRoot(trustContext, head) {
    if (!trustContext.rootState || !head) return;
    const state = trustContext.rootState;
    if (head.version < state.manifestHeadVersion ||
        (head.version === state.manifestHeadVersion && head.digest !== state.manifestHeadDigest)) {
      fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_BEHIND_ROOT_STATE', 'Manifest anchor history is behind or conflicts with the root-transition manifest head');
    }
    if (head.version > state.manifestHeadVersion) {
      let anchored;
      try {
        anchored = await this.externalAnchorStore.getManifest(head.version, {
          trustedRootKeys: trustContext.trustedRootKeys
        });
      } catch {
        fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_INVALID', 'Current manifest head could not be verified against reconstructed root state');
      }
      if (!anchored || anchored.digest !== head.digest ||
          anchored.manifest.rootKeyId !== state.rootKeyId) {
        fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_ROOT_MISMATCH', 'Manifest head after root activation must be signed by the currently effective root');
      }
    }
  }

  async recover({ principal } = {}) {
    let authorized = false;
    try {
      authorized = await this.authorize(principal, 'trust-manifest.recover');
    } catch {
      fail('EVIDENCE_TRUST_MANIFEST_AUTHORIZATION_FAILED', 'Trust-state recovery authorization could not be established');
    }
    if (authorized !== true) {
      fail('EVIDENCE_TRUST_MANIFEST_FORBIDDEN', 'Principal is not authorized to recover trust state');
    }

    const trustContext = await this.resolveTrustContext();
    const head = await this.externalAnchorStore.readHead({ trustedRootKeys: trustContext.trustedRootKeys });
    if (!head) {
      fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_EMPTY', 'No independently anchored trust history is available for recovery');
    }
    await this.verifyExternalHeadRoot(trustContext, head);
    const current = await this.versionStore.read();
    if (current !== null && (!current || !Number.isSafeInteger(current.version) ||
        current.version < 1 || !/^[a-f0-9]{64}$/.test(current.digest || ''))) {
      fail('EVIDENCE_TRUST_MANIFEST_STORE_INVALID', 'Monotonic trust cache is malformed');
    }
    if (current && current.version > head.version) {
      fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_BEHIND_CACHE', 'External trust history is behind the local cache; recovery is refused');
    }
    if (current && current.version === head.version) {
      if (current.digest !== head.digest) {
        fail('EVIDENCE_TRUST_MANIFEST_VERSION_CONFLICT', 'Local cache conflicts with the independently anchored trust head');
      }
      return Object.freeze({ version: head.version, digest: head.digest, recovered: false });
    }
    const recovered = await this.versionStore.compareAndSet(
      current,
      { version: head.version, digest: head.digest }
    );
    if (!recovered) {
      fail('EVIDENCE_TRUST_MANIFEST_STATE_RACE', 'Trust cache changed during recovery; reload and retry');
    }
    return Object.freeze({ version: head.version, digest: head.digest, recovered: true });
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

    const trustContext = await this.resolveTrustContext();
    if (trustContext.rootState && manifest?.rootKeyId !== trustContext.rootState.rootKeyId) {
      fail('EVIDENCE_TRUST_MANIFEST_ROOT_NOT_ACTIVE', 'Only the currently effective root may authorize a new trust manifest');
    }
    if (trustContext.rootState && (!Number.isSafeInteger(manifest?.version) ||
        manifest.version <= trustContext.rootState.manifestHeadVersion)) {
      fail('EVIDENCE_TRUST_MANIFEST_ROOT_HEAD_ROLLBACK', 'A manifest signed under the active root must advance beyond the manifest head bound by its activation transition');
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
    const verified = verifyTrustManifest(manifest, trustContext.trustedRootKeys, { verificationTime: now });
    if (!verified) {
      fail('EVIDENCE_TRUST_MANIFEST_SIGNATURE_INVALID', 'Trust manifest signature or validity is invalid');
    }

    const externalHead = await this.externalAnchorStore.readHead({ trustedRootKeys: trustContext.trustedRootKeys });
    await this.verifyExternalHeadRoot(trustContext, externalHead);
    const cachedState = await this.versionStore.read();
    if (cachedState !== null && (!cachedState || !Number.isSafeInteger(cachedState.version) ||
        cachedState.version < 1 || !/^[a-f0-9]{64}$/.test(cachedState.digest || ''))) {
      fail('EVIDENCE_TRUST_MANIFEST_STORE_INVALID', 'Monotonic trust cache is malformed');
    }
    if (cachedState && externalHead && cachedState.version > externalHead.version) {
      fail('EVIDENCE_TRUST_MANIFEST_ANCHOR_BEHIND_CACHE', 'External trust history is behind the local cache; refusing to append');
    }
    if (cachedState && cachedState.version > verified.version) {
      fail('EVIDENCE_TRUST_MANIFEST_ROLLBACK', 'Manifest is older than the local monotonic trust cache');
    }
    if (cachedState && cachedState.version === verified.version && cachedState.digest !== verified.digest) {
      fail('EVIDENCE_TRUST_MANIFEST_VERSION_CONFLICT', 'Manifest conflicts with the local monotonic trust cache');
    }
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
      await this.externalAnchorStore.append(manifest, {
        verificationTime: now,
        trustedRootKeys: trustContext.trustedRootKeys
      });
    }

    const accepted = await verifyAndAcceptTrustManifest(manifest, {
      trustedRootKeys: trustContext.trustedRootKeys,
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
