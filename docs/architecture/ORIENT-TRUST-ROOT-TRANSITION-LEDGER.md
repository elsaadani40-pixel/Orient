# ORIENT External Trust Root Transition Ledger

## Status

The root-transition signing/verifier primitives, immutable ledger adapter contract, full-history state reconstruction, and manifest-acceptance integration are implemented. Automated tests use in-memory backends and ephemeral Ed25519 keys. No real external provider has been provisioned or verified.

No AWS resources have been created and no real root or recovery keys have been generated.

## Backend contract

The adapter requires a backend with these operations:

- `putIfAbsent(key, value) -> { created: boolean, existingValue?: string }`
- `get(key) -> string | null`
- `list(prefix) -> Array<{ key: string, value: string }>`

The backend must provide strongly consistent conditional creation and independently enforced no-overwrite/no-delete permissions. The adapter cannot make a mutable object store immutable by itself.

The dedicated namespace is:

```text
orient/trust-root-transitions/v1/<16-digit-sequence>.json
```

The namespace version is a storage-layout version, not the signed transition schema version.

## Bootstrap contract

The loader requires an independently pinned bootstrap configuration:

- initial root epoch, key ID, and SHA-256 SPKI fingerprint;
- initial manifest head version and digest;
- transition sequence zero and null transition digest;
- the complete used-root history at bootstrap (for a fresh bootstrap, exactly the initial root ID and fingerprint);
- pinned recovery authority public keys and explicit threshold;
- bounded clock-skew and transition-validity policy.

The constructor checks that the initial root key matches the pinned fingerprint and that the initial used-root history contains exactly that bootstrap root. It does not fetch bootstrap trust from the transition backend.

## Append and replay

`appendIfNext(envelope, expectedHead)`:

1. Replays and verifies the entire existing transition ledger.
2. Compares the caller's expected head with the verified ledger head.
3. Resolves the current external manifest head and requires the candidate to bind that exact version, digest, and active signing root. Verifies the candidate against the effective root state, recovery policy, time window, and transition sequence.
4. Uses conditional create-only storage.
5. Replays the entire ledger again after a successful write before reporting success.
6. Treats an exact retry of an already verified envelope as idempotent; different content at the same sequence is a conflict.

`readHistory()` starts only from pinned bootstrap material and verifies every transition in sequence. If a later transition binds a newer manifest head, the injected manifest-head verifier must confirm that exact version/digest exists and was signed by the then-active root. Historical replay evaluates each transition at its signed effective time and requires it to have been valid at that time. This permits a previously accepted transition to remain auditable after its short acceptance window expires. Historical replay is not a way to accept a new transition: `appendIfNext` always performs current-time verification.

`readState()` exposes the reconstructed active root, root epoch, manifest-head binding, transition head, and the count of verified transitions. A partial or invalid history throws; no partially reconstructed trust state is returned.

## Security properties and boundaries

- Root private keys and recovery private keys are never stored by this adapter.
- Runtime should not receive the backend writer credential.
- Every transition is signature-verified and chained to the exact prior transition digest.
- The complete root ID and fingerprint history is retained to prevent reuse.
- Emergency recovery requires the separately pinned recovery quorum and next-root proof of possession; the compromised root is not counted.
- Exact idempotent retries do not create another record.
- Sequence gaps, malformed/non-canonical records, conflicting content, stale heads, invalid signatures, and unavailable history fail closed.

The adapter accepts two host-controlled callbacks: `manifestHeadProvider({ trustedRootKeys, expectedRootKeyId, activeFromVersion })`, which must return the current externally anchored manifest `{ version, digest, rootKeyId }`, and `manifestHeadVerifier({ version, digest, expectedRootKeyId, activeFromVersion, trustedRootKeys })`, which must prove the exact historical anchor and every manifest since the prior activation were signed by the root active at that point. The append path checks the exact current head; replay checks each signed historical head against the external manifest ledger. `ExternalTrustManifestAnchorStore` exposes `readHead`, `getManifest`, and `hasAnchor` for this purpose. When an active root and activation version are supplied, `readHead` and `append` reject any manifest after that activation boundary signed by another root; `hasAnchor` validates the full contiguous manifest prefix up to the transition-bound head, not only the final object. `AnchoredTrustManifestAcceptanceService` can consume `rootTransitionLedger.readState()` and accepts new manifests only from the reconstructed active root, strictly after the head bound by its activation transition. These callbacks are security-critical host wiring and must not be replaced by caller-supplied values.

The current tests include sequential root rotations across manifest-head advances, delayed retired-root manifest rejection (including a retired-root entry hidden before a newer active-root head), and end-to-end acceptance through an in-memory manifest anchor backend. They use ephemeral Ed25519 keys. They do not prove provider-side immutability, independent account custody, real network consistency, disaster recovery, or production key operations.
