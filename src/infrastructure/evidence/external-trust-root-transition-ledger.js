'use strict';

const { canonicalJson } = require('../../core/execution/evidence-record');
const { verifyRootTransition, publicKeyFingerprint, recoveryPolicyDigest } = require('./trusted-evidence-root-transition');

const PREFIX = 'orient/trust-root-transitions/v1/';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function keyForSequence(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    fail('EVIDENCE_ROOT_TRANSITION_LEDGER_INVALID', 'Transition sequence must be a positive safe integer');
  }
  return `${PREFIX}${String(sequence).padStart(16, '0')}.json`;
}

function parseEnvelope(value) {
  if (typeof value !== 'string') {
    fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CORRUPT', 'Stored transition must be UTF-8 JSON text');
  }
  let envelope;
  try {
    envelope = JSON.parse(value);
    if (canonicalJson(envelope) !== value) throw new Error('non-canonical');
  } catch {
    fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CORRUPT', 'Stored transition is malformed or non-canonical');
  }
  return envelope;
}

function cloneState(state) {
  return {
    rootEpoch: state.rootEpoch,
    rootKeyId: state.rootKeyId,
    rootFingerprint: state.rootFingerprint,
    manifestHeadVersion: state.manifestHeadVersion,
    manifestHeadDigest: state.manifestHeadDigest,
    transitionSequence: state.transitionSequence,
    transitionDigest: state.transitionDigest,
    usedRootKeyIds: [...state.usedRootKeyIds],
    usedRootFingerprints: [...state.usedRootFingerprints]
  };
}

/**
 * Full-history immutable root-transition ledger.
 *
 * The backend must implement strongly consistent putIfAbsent/get/list and
 * deny overwrite/delete to its writer identity. Runtime must not possess that
 * writer credential. The initial root and recovery policy are independently
 * pinned bootstrap inputs, never read from this ledger.
 */
class ExternalTrustRootTransitionLedger {
  constructor({
    backend,
    initialState,
    trustedRootKeys,
    recoveryPolicy,
    clockSkewMs,
    maxValidityMs,
    manifestHeadProvider,
    manifestHeadVerifier,
    now = () => new Date().toISOString()
  } = {}) {
    if (!backend || typeof backend.putIfAbsent !== 'function' ||
        typeof backend.get !== 'function' || typeof backend.list !== 'function') {
      throw new TypeError('An immutable external root-transition backend is required');
    }
    if (!initialState || !Number.isSafeInteger(initialState.rootEpoch) ||
        initialState.rootEpoch < 1 || !Number.isSafeInteger(initialState.manifestHeadVersion) ||
        initialState.manifestHeadVersion < 1 ||
        !Number.isSafeInteger(initialState.transitionSequence) ||
        initialState.transitionSequence !== 0 || initialState.transitionDigest !== null ||
        typeof initialState.rootKeyId !== 'string' ||
        !Array.isArray(initialState.usedRootKeyIds) ||
        !Array.isArray(initialState.usedRootFingerprints)) {
      throw new TypeError('A complete pinned root-transition bootstrap state is required');
    }
    if (!trustedRootKeys || typeof trustedRootKeys !== 'object' ||
        !recoveryPolicy || typeof recoveryPolicy !== 'object') {
      throw new TypeError('Pinned root keys and recovery policy are required');
    }
    const initialRoot = trustedRootKeys[initialState.rootKeyId];
    if (!initialRoot || typeof initialRoot.publicKey !== 'string' ||
        publicKeyFingerprint(initialRoot.publicKey) !== initialState.rootFingerprint ||
        initialState.usedRootKeyIds.length !== 1 ||
        initialState.usedRootKeyIds[0] !== initialState.rootKeyId ||
        initialState.usedRootFingerprints.length !== 1 ||
        initialState.usedRootFingerprints[0] !== initialState.rootFingerprint) {
      throw new TypeError('Bootstrap must pin exactly the initial root ID and fingerprint');
    }
    recoveryPolicyDigest(recoveryPolicy);
    if (typeof now !== 'function') throw new TypeError('A clock function is required');
    if ((manifestHeadProvider === undefined) !== (manifestHeadVerifier === undefined) ||
        (manifestHeadProvider !== undefined && typeof manifestHeadProvider !== 'function') ||
        (manifestHeadVerifier !== undefined && typeof manifestHeadVerifier !== 'function')) {
      throw new TypeError('Manifest head provider and verifier must be supplied together');
    }
    this.backend = backend;
    this.initialState = cloneState(initialState);
    this.initialTrustedRootKeys = structuredClone(trustedRootKeys);
    this.recoveryPolicy = structuredClone(recoveryPolicy);
    this.clockSkewMs = clockSkewMs;
    this.maxValidityMs = maxValidityMs;
    this.manifestHeadProvider = manifestHeadProvider || null;
    this.manifestHeadVerifier = manifestHeadVerifier || null;
    this.now = now;
  }

  async readHistory() {
    const entries = await this.backend.list(PREFIX);
    if (!Array.isArray(entries)) {
      fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CONTRACT_INVALID', 'Backend list must return an array');
    }
    const parsed = entries.map(entry => {
      if (!entry || typeof entry.key !== 'string' || !entry.key.startsWith(PREFIX)) {
        fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CORRUPT', 'Backend returned an entry outside the root-transition namespace');
      }
      const envelope = parseEnvelope(entry.value);
      if (keyForSequence(envelope?.payload?.transitionSequence) !== entry.key) {
        fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CORRUPT', 'Transition key does not match its signed sequence');
      }
      return { key: entry.key, envelope };
    }).sort((a, b) => a.envelope.payload.transitionSequence - b.envelope.payload.transitionSequence);

    const state = cloneState(this.initialState);
    const trustedRootKeys = structuredClone(this.initialTrustedRootKeys);
    const verifiedTransitions = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const { envelope } = parsed[index];
      if (envelope.payload.transitionSequence !== index + 1) {
        fail('EVIDENCE_ROOT_TRANSITION_LEDGER_GAP', 'Root-transition history must be contiguous from sequence 1');
      }
      if (envelope.payload.manifestHeadVersion < state.manifestHeadVersion) {
        fail('EVIDENCE_ROOT_TRANSITION_MANIFEST_HEAD_ROLLBACK', 'A root transition cannot bind an older manifest head');
      }
      if (envelope.payload.manifestHeadVersion === state.manifestHeadVersion) {
        if (envelope.payload.manifestHeadDigest !== state.manifestHeadDigest) {
          fail('EVIDENCE_ROOT_TRANSITION_MANIFEST_HEAD_CONFLICT', 'Manifest digest conflicts with the previously verified head');
        }
      } else {
        if (!this.manifestHeadVerifier) {
          fail('EVIDENCE_ROOT_TRANSITION_MANIFEST_HEAD_UNVERIFIABLE', 'Manifest head advancement requires an independent anchor verifier');
        }
        let anchored = false;
        try {
          anchored = await this.manifestHeadVerifier({
            version: envelope.payload.manifestHeadVersion,
            digest: envelope.payload.manifestHeadDigest,
            expectedRootKeyId: state.rootKeyId,
            trustedRootKeys
          });
        } catch {
          fail('EVIDENCE_ROOT_TRANSITION_MANIFEST_HEAD_UNVERIFIABLE', 'Manifest head anchor verification failed');
        }
        if (anchored !== true) {
          fail('EVIDENCE_ROOT_TRANSITION_MANIFEST_HEAD_UNVERIFIABLE', 'Transition manifest head is not independently anchored under the active root');
        }
        state.manifestHeadVersion = envelope.payload.manifestHeadVersion;
        state.manifestHeadDigest = envelope.payload.manifestHeadDigest;
      }
      const verified = verifyRootTransition(envelope, {
        trustedRootKeys,
        recoveryPolicy: this.recoveryPolicy,
        expectedState: state,
        verificationTime: envelope.payload.effectiveAt,
        clockSkewMs: this.clockSkewMs,
        maxValidityMs: this.maxValidityMs,
        historicalReplay: true
      });
      if (!verified) {
        fail('EVIDENCE_ROOT_TRANSITION_LEDGER_INVALID', `Root-transition ${index + 1} failed full-history verification`);
      }
      const previous = trustedRootKeys[state.rootKeyId];
      trustedRootKeys[state.rootKeyId] = {
        ...previous,
        revokedAt: envelope.payload.effectiveAt
      };
      trustedRootKeys[verified.nextRoot.keyId] = {
        publicKey: verified.nextRoot.publicKey,
        validFrom: envelope.payload.effectiveAt
      };
      state.rootEpoch = envelope.payload.nextRootEpoch;
      state.rootKeyId = verified.nextRoot.keyId;
      state.rootFingerprint = verified.nextRoot.fingerprint;
      state.transitionSequence = envelope.payload.transitionSequence;
      state.transitionDigest = verified.transitionDigest;
      state.usedRootKeyIds.push(verified.nextRoot.keyId);
      state.usedRootFingerprints.push(verified.nextRoot.fingerprint);
      verifiedTransitions.push(verified);
    }

    return Object.freeze({
      state: Object.freeze(cloneState(state)),
      trustedRootKeys: Object.freeze(trustedRootKeys),
      transitions: Object.freeze(verifiedTransitions),
      head: state.transitionSequence === 0 ? null : Object.freeze({
        transitionSequence: state.transitionSequence,
        transitionDigest: state.transitionDigest
      })
    });
  }

  async appendIfNext(envelope, expectedHead = null) {
    const current = await this.readHistory();
    const candidateSequence = envelope?.payload?.transitionSequence;
    if (Number.isSafeInteger(candidateSequence) && candidateSequence >= 1 &&
        candidateSequence <= current.state.transitionSequence) {
      const existingValue = await this.backend.get(keyForSequence(candidateSequence));
      if (typeof existingValue !== 'string') {
        fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CORRUPT', 'A transition already in verified history but cannot be read back');
      }
      const existing = parseEnvelope(existingValue);
      if (canonicalJson(existing) !== canonicalJson(envelope)) {
        fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CONFLICT', 'An immutable transition already exists at this sequence with different content');
      }
      return {
        created: false,
        transitionSequence: candidateSequence,
        transitionDigest: existing.transitionDigest
      };
    }
    const actualHead = current.head;
    if (canonicalJson(actualHead) !== canonicalJson(expectedHead)) {
      fail('EVIDENCE_ROOT_TRANSITION_LEDGER_HEAD_CONFLICT', 'Expected transition head is stale; reload and prepare a new signed transition');
    }
    const verificationTime = this.now();
    const expectedState = cloneState(current.state);
    if (this.manifestHeadProvider) {
      let manifestHead;
      try {
        manifestHead = await this.manifestHeadProvider({
          trustedRootKeys: current.trustedRootKeys,
          expectedRootKeyId: current.state.rootKeyId
        });
      } catch {
        fail('EVIDENCE_ROOT_TRANSITION_MANIFEST_HEAD_UNAVAILABLE', 'Current external manifest head could not be resolved');
      }
      if (!manifestHead || !Number.isSafeInteger(manifestHead.version) ||
          manifestHead.version < expectedState.manifestHeadVersion ||
          !/^[a-f0-9]{64}$/.test(manifestHead.digest || '') ||
          (manifestHead.version === expectedState.manifestHeadVersion &&
            manifestHead.digest !== expectedState.manifestHeadDigest) ||
          envelope?.payload?.manifestHeadVersion !== manifestHead.version ||
          envelope?.payload?.manifestHeadDigest !== manifestHead.digest) {
        fail('EVIDENCE_ROOT_TRANSITION_MANIFEST_HEAD_CONFLICT', 'Transition must bind the exact current independently anchored manifest head');
      }
      expectedState.manifestHeadVersion = manifestHead.version;
      expectedState.manifestHeadDigest = manifestHead.digest;
    }
    const verified = verifyRootTransition(envelope, {
      trustedRootKeys: current.trustedRootKeys,
      recoveryPolicy: this.recoveryPolicy,
      expectedState,
      verificationTime,
      clockSkewMs: this.clockSkewMs,
      maxValidityMs: this.maxValidityMs
    });
    if (!verified) {
      fail('EVIDENCE_ROOT_TRANSITION_INVALID', 'Transition failed current-state signature, time, or policy verification');
    }
    const key = keyForSequence(verified.payload.transitionSequence);
    const value = canonicalJson(envelope);
    const result = await this.backend.putIfAbsent(key, value);
    if (!result || typeof result.created !== 'boolean') {
      fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CONTRACT_INVALID', 'Backend putIfAbsent must return a created boolean');
    }
    if (result.created) {
      const replayed = await this.readHistory();
      if (replayed.head?.transitionDigest !== verified.transitionDigest) {
        fail('EVIDENCE_ROOT_TRANSITION_LEDGER_POST_WRITE_INVALID', 'Transition did not become the verified immutable ledger head');
      }
      return { created: true, ...replayed.head };
    }
    const existingValue = typeof result.existingValue === 'string'
      ? result.existingValue
      : await this.backend.get(key);
    if (existingValue === null || existingValue === undefined) {
      fail('EVIDENCE_ROOT_TRANSITION_LEDGER_RACE', 'Existing transition could not be read back');
    }
    const existing = parseEnvelope(existingValue);
    if (canonicalJson(existing) !== value) {
      fail('EVIDENCE_ROOT_TRANSITION_LEDGER_CONFLICT', 'An immutable transition already exists at this sequence with different content');
    }
    return { created: false, transitionSequence: verified.payload.transitionSequence,
      transitionDigest: verified.transitionDigest };
  }

  async readState() {
    const history = await this.readHistory();
    return Object.freeze({
      ...history.state,
      activeRoot: history.trustedRootKeys[history.state.rootKeyId],
      verifiedTransitionCount: history.transitions.length
    });
  }
}

module.exports = { ExternalTrustRootTransitionLedger, keyForSequence, PREFIX };
