# ORIENT Trust Root Transition and Recovery Protocol

## Status

**Protocol design specification — implementation pending.** This document is the normative design gate for automated root rotation and emergency root recovery. It does not activate any key, change a deployed trust configuration, or establish a production trust guarantee.

The protocol is deliberately separate from the evidence-key list in a trust manifest. A manifest cannot introduce a trust root merely by listing its public key.

## Security objectives

1. Permit planned root rotation without putting root private keys in Runtime.
2. Require proof of possession by every proposed replacement root.
3. Permit emergency recovery when the current root is compromised, without relying on that compromised root to authorize its replacement.
4. Prevent replay, rollback, cross-protocol signature reuse, conflicting transitions, and silent trust-set replacement.
5. Bind every transition to the exact prior root state and exact accepted manifest head.
6. Keep transition history independently append-only and administratively separate from Runtime and the PostgreSQL cache.
7. Make recovery fail closed if independently pinned recovery authority was not provisioned before the incident.

## Threat model and explicit limits

The protocol assumes:
- Runtime, its application database, and ordinary application credentials may be compromised.
- A currently trusted root private key may be compromised in the emergency scenario.
- The external transition ledger provides strongly consistent create-only writes and independently controlled read access.
- Initial root public keys and recovery public keys are provisioned through an independently reviewed out-of-band ceremony.
- Private root and recovery keys are held offline or in independently controlled hardware-backed custody.

The protocol does not claim to survive simultaneous compromise of the independently pinned recovery quorum, the external ledger's administrative control plane, and the trusted configuration distribution channel. Cryptography cannot bootstrap trust if every independent trust anchor is lost.

A hash chain alone is not an authenticity guarantee. Each transition is signed, and the transition ledger must enforce immutable, conditional creation outside Runtime's authority.

## Trust domains and roles

- **Current root:** authorizes ordinary planned rotation while it remains trusted.
- **Next root:** proves possession of the proposed replacement private key.
- **Recovery authorities:** a separately pinned set of Ed25519 public keys, with a configured threshold. They are not members of the ordinary root key set by implication.
- **Transition ledger:** independent append-only store, separate from manifest anchors and PostgreSQL.
- **Trust-state loader:** host-controlled component that replays and verifies the complete transition history against the initial pinned configuration before constructing the effective root set.
- **Runtime:** receives only the resulting verified public-key set. It never receives root or recovery private keys and cannot write the transition ledger.

The recovery threshold is explicit configuration. There is no implicit default such as 1-of-1 or 2-of-3. An absent or invalid recovery configuration disables emergency automated recovery and requires out-of-band trust re-bootstrap.

## Canonical transition envelope

All timestamps are canonical UTC ISO-8601 strings. All public keys are Ed25519 SPKI PEM. All fingerprints are lowercase SHA-256 hex over DER-encoded SPKI public-key bytes. All signatures are canonical base64 Ed25519 signatures over domain-separated canonical JSON.

A transition payload has exactly these fields:

- `schemaVersion: 1`
- `transitionSequence`: positive safe integer, contiguous from 1
- `previousTransitionDigest`: null for the first transition, otherwise the prior transition digest
- `mode`: `planned-rotation` or `emergency-recovery`
- `previousRootEpoch`: positive safe integer
- `nextRootEpoch`: exactly previousRootEpoch + 1
- `previousRootKeyId`: current root identifier (the emergency mode still names the compromised root for audit)
- `previousRootFingerprint`: fingerprint of the currently effective root public key
- `nextRootKeyId`: new, never-reused root identifier
- `nextRootPublicKey`: proposed Ed25519 public key
- `nextRootFingerprint`: fingerprint derived from nextRootPublicKey
- `manifestHeadVersion`: exact externally anchored manifest version at transition preparation
- `manifestHeadDigest`: exact digest of that anchored manifest
- `issuedAt`, `effectiveAt`, `expiresAt`: canonical timestamps
- `recoveryPolicyDigest`: digest of the independently pinned recovery-authority IDs, public-key fingerprints, and threshold

The signed envelope contains the payload, the authorization signatures, and its canonical transition digest. Unknown fields, accessors, symbols, noncanonical encodings, invalid key types, and inconsistent derived fingerprints are rejected.

The recovery-policy digest includes each authority's ID, public-key fingerprint, `validFrom` and `revokedAt` metadata, plus the threshold. The transition digest is SHA-256 over the canonical payload and authorization-signature set, prefixed by the transition-envelope domain separator. The transition digest is not itself a signature.

## Signature domains and authorization rules

Use distinct, NUL-terminated domain separators:

- `ORIENT-TRUST-ROOT-TRANSITION-V1\0` for authorization signatures.
- `ORIENT-TRUST-ROOT-PROOF-OF-POSSESSION-V1\0` for the next-root proof.
- `ORIENT-TRUST-ROOT-TRANSITION-DIGEST-V1\0` for the envelope digest.

No signature from the manifest, evidence-record, evidence-anchor, or other protocol domains is valid for root transition authorization.

### Planned rotation

A planned transition is valid only when all conditions hold:

1. The current root is present in the effective trusted-root set and is valid at both issuance and the transition's effective time.
2. The current root signs the exact canonical transition payload.
3. The proposed next root signs the same payload in the separate proof-of-possession domain.
4. The previous root epoch, key ID, fingerprint, manifest head version, and manifest head digest exactly match the independently verified current state.
5. The next root ID is not already used by any current, historical, or revoked root.
6. The transition sequence and previous digest extend the exact current transition-ledger head.
7. The transition is within its validity window and does not violate the configured clock-skew policy.

The old root signature authorizes planned succession; the new root signature proves that the proposed custodian controls the new private key. Neither signature alone is sufficient.

### Emergency recovery

An emergency transition is valid only when all conditions hold:

1. The recovery-authority set and threshold were pinned independently before the incident.
2. At least the configured threshold of distinct recovery keys sign the exact transition payload in the root-transition domain.
3. Every signer is a configured recovery authority, valid at issuance, not revoked at issuance, and counted once.
4. The payload names the exact prior root epoch, key ID, fingerprint, manifest head, transition-ledger head, and recovery-policy digest.
5. The proposed next root provides proof of possession in the separate proof-of-possession domain.
6. The old root's signature is neither required nor accepted as a substitute for the recovery quorum.
7. The transition extends the exact immutable transition-ledger head and passes all timestamp and identifier checks.

A recovery quorum may authorize replacement even when the old root is compromised. An old-root signature cannot override, reduce, or replace the recovery threshold.

## Time policy

- `issuedAt` cannot be later than verifier time plus the explicitly configured clock skew.
- `expiresAt` must be later than `issuedAt` and no more than the configured maximum transition lifetime.
- A transition cannot be accepted before `effectiveAt`.
- The transition is accepted only while it is unexpired.
- The current root/recovery signer validity is evaluated at issuance and at acceptance according to the configured revocation policy. A signer revoked before acceptance cannot authorize a delayed transition.
- Historical audit verification is a separate mode. It may prove that signatures were valid under the historical pinned policy, but it must never return an activatable trust state.

The initial implementation must make clock skew and maximum transition lifetime explicit bounded configuration; it must not silently inherit manifest expiry settings.

## Ledger and anti-rollback rules

The independent transition ledger exposes only:

- `readHead() -> null | { transitionSequence, transitionDigest }`
- `appendIfNext(envelope, expectedHead) -> created | exact-existing`

The backend must provide strongly consistent conditional creation and deny overwrite/delete to the transition-writer identity. Runtime has no write credential.

The expected bootstrap state must carry the complete historical set of used root IDs and fingerprints; the verifier rejects missing history and any reused ID or public-key fingerprint. A valid ledger is contiguous from sequence 1. Each entry's previous digest must equal the prior entry's digest. Duplicate sequence with different content, gaps, reordered history, unknown objects in the namespace, or a head that conflicts with the pinned bootstrap state are fatal.

The ledger is independent from the trust-manifest anchor ledger. A manifest version does not substitute for a root-transition sequence, and a transition does not silently rewrite an already anchored manifest.

The transition payload binds the current manifest head. After a transition becomes effective, the first manifest signed by the new root must be the next contiguous manifest version. If the manifest head changes between transition preparation and acceptance, the transition is stale and must be prepared and signed again.

## State reconstruction and activation

The trust-state loader starts from a separately pinned bootstrap configuration containing:
- initial root public keys and their IDs/fingerprints/validity;
- recovery-authority public keys and their threshold policy;
- initial root epoch;
- the initial manifest head reference, if bootstrap has already occurred;
- the expected transition-ledger namespace and policy digest.

It then reads the complete transition ledger from the independent backend, validates every envelope and chain link in order, and applies each transition to an in-memory trust-state snapshot.

For every transition it must:
1. verify canonical structure and digest;
2. verify sequence and previous digest;
3. verify the previous root epoch/ID/fingerprint;
4. verify the bound manifest head;
5. verify mode-specific signatures and next-root proof of possession;
6. enforce time and key validity;
7. retire the previous root for new acceptance at the effective time;
8. install the next root and increment the epoch.

The loader returns the effective public-key set and verified ledger head only after the entire history succeeds. Partial replay is never exposed. The Runtime must fail closed if the ledger is unavailable, incomplete, conflicting, or invalid. Historical audit tools may expose verified historical states separately, but Runtime acceptance uses only the current effective state.

Root IDs are never reused, including after revocation. Old public keys may remain available for historical signature verification, but they are not active authorization keys.

## Manifest acceptance integration

The trust-manifest acceptance path must consume the verified effective root state from the trust-state loader, not a caller-supplied manifest key set and not a key introduced by the candidate manifest.

The acceptance transaction must compare the candidate manifest version against:
- the immutable manifest-anchor head;
- the durable local cache;
- the manifest head bound by the latest effective root transition.

A new root can sign only a manifest version strictly after the transition's bound manifest head. An old root cannot sign new manifests after the transition becomes effective. Historical verification remains available with an explicitly historical API and cannot update trust state.

## Failure behavior

Fail closed for:
- missing or empty recovery quorum configuration during emergency recovery;
- fewer than threshold distinct recovery signatures;
- duplicate recovery signer IDs;
- unknown, expired, not-yet-valid, or revoked signer;
- invalid or missing next-root proof of possession;
- old-root signature presented as emergency authority;
- wrong signature domain;
- key ID reuse or fingerprint mismatch;
- sequence gap, replay, rollback, fork, or same-sequence content conflict;
- stale manifest head or stale prior transition digest;
- expired or future-issued transition;
- unavailable or untrusted external ledger;
- malformed pinned policy or recovery-policy digest mismatch.

No automatic fallback to a PostgreSQL-only transition state is permitted.

## Required test matrix

Use ephemeral Ed25519 keypairs only. Never generate or activate real user keys in CI.

Positive cases:
- valid planned rotation with old-root authorization and next-root proof of possession;
- valid emergency recovery with exactly threshold signatures;
- valid emergency recovery with more than threshold signatures;
- complete ledger replay across multiple planned and emergency transitions;
- exact append retry returns the already anchored transition without changing state.

Negative cases:
- old-root-only planned rotation;
- new-root proof without old-root authorization;
- missing or invalid proof of possession;
- emergency transition with no configured recovery policy;
- fewer than threshold signatures;
- duplicate signer IDs;
- unknown, revoked, or not-yet-valid recovery signer;
- emergency transition relying on the compromised old root instead of recovery quorum;
- wrong domain, altered payload, altered signature, malformed base64;
- wrong previous root fingerprint/epoch/ID;
- wrong manifest head version/digest;
- wrong recovery-policy digest;
- reused root ID;
- future-issued, expired, or not-yet-effective transition;
- replay, rollback, sequence gap, fork, duplicate sequence with different content;
- tampered external ledger entry, missing entry, invalid chain link;
- stale transition after manifest head advances;
- historical verification incorrectly offered as current activation;
- ledger unavailable during runtime trust-state reconstruction.

## Implementation sequence and release gates

1. Implement pure canonicalization, key fingerprinting, signing, and verification primitives with the domain separation above.
2. Implement a transition-ledger adapter contract and an independently immutable backend adapter; test with a fake backend first.
3. Implement full-history trust-state reconstruction from pinned bootstrap policy.
4. Integrate the loader with manifest acceptance so new roots become effective only through verified transitions.
5. Add the complete positive/negative test matrix and restart/replay tests.
6. Update offline tooling and operator documentation only after the API and test behavior are stable.
7. Run focused tests, full repository CI, CodeQL, and static security checks on the exact same branch SHA.

Do not declare root lifecycle complete until all seven gates pass. Do not begin ToolSpec or Unified Tool Gateway work before this milestone is closed.

## Operational non-goals

This protocol does not generate real root or recovery keys, configure AWS, apply Terraform, change S3 Object Lock retention, deploy a trust service, or modify hosted Supabase. Real key custody, two-person approval, independent recovery media, external-store administration, and production-provider drills remain operator responsibilities.
