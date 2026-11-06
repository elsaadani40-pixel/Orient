# ORIENT External Trust Root Transition Ledger

## Status

The first implementation of the root-transition ledger and deterministic replay adapter is present. It is an application-level adapter contract with an in-memory test backend; it is not yet connected to a real external provider or to the production manifest acceptance path.

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
3. Verifies the candidate against the current effective root state, recovery policy, time window, manifest head, and transition sequence.
4. Uses conditional create-only storage.
5. Replays the entire ledger again after a successful write before reporting success.
6. Treats an exact retry of an already verified envelope as idempotent; different content at the same sequence is a conflict.

`readHistory()` starts only from pinned bootstrap material and verifies every transition in sequence. Historical replay evaluates each transition at its signed effective time and requires it to have been valid at that time. This permits a previously accepted transition to remain auditable after its short acceptance window expires. Historical replay is not a way to accept a new transition: `appendIfNext` always performs current-time verification.

`readState()` exposes the reconstructed active root, root epoch, manifest-head binding, transition head, and the count of verified transitions. A partial or invalid history throws; no partially reconstructed trust state is returned.

## Security properties and boundaries

- Root private keys and recovery private keys are never stored by this adapter.
- Runtime should not receive the backend writer credential.
- Every transition is signature-verified and chained to the exact prior transition digest.
- The complete root ID and fingerprint history is retained to prevent reuse.
- Emergency recovery requires the separately pinned recovery quorum and next-root proof of possession; the compromised root is not counted.
- Exact idempotent retries do not create another record.
- Sequence gaps, malformed/non-canonical records, conflicting content, stale heads, invalid signatures, and unavailable history fail closed.

The current adapter assumes that the signed manifest-head reference remains stable across the transition history supplied to it. A complete production integration must coordinate manifest-anchor history and root-transition history as one ordered trust event stream, so that a later transition is checked against the exact manifest head current at that point in time. Until that cross-ledger chronology is implemented and tested, this adapter must not be treated as the final manifest-acceptance authority.

The current tests use ephemeral Ed25519 keys and an in-memory backend. They do not prove provider-side immutability, independent account custody, real network consistency, disaster recovery, or production key operations.
