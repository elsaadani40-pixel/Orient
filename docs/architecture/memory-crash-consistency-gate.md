# Memory crash-consistency gate

Status: **blocking — implementation and crash tests required**

## Finding

`MemoryService` mutates the JSON memory repository and then appends to a separate JSON audit repository. The repositories each publish files atomically, but the pair is not one transaction. Exception compensation only covers failures observed while the process remains alive. A process or machine crash between writes can leave memory state without its matching audit event, or leave a partially completed multi-record consolidation.

This document records the rollout gate; it does not claim to implement crash consistency.

## Required implementation

Use one durable operation journal as the source of recovery truth for each memory mutation. Every journal record must include a stable operation ID, tenant ID, scope, operation kind, schema version, before/after state (or a deterministic mutation payload), the required audit event, and a durable state transition. Tenant/scope must be checked on every lookup and recovery action.

The implementation must:
1. Durably publish a prepared operation before changing memory state.
2. Apply the mutation idempotently and ensure the corresponding audit event is present.
3. Durably mark the operation committed only after both state and audit are reconciled.
4. Recover prepared/incomplete operations deterministically at startup before serving reads or writes.
5. Fail closed on corrupt/ambiguous journal state; never silently discard it or guess.
6. Serialize operations that touch the same memory and define lock ordering to avoid deadlocks.
7. Preserve legacy memory/audit data with an explicit, tested migration path.
8. Avoid treating a local journal as proof that an external provider side effect is idempotent.

## Mandatory tests

- Child process exits immediately after durable prepare.
- Child process exits after memory publication but before audit publication.
- Child process exits after audit publication but before committed marker.
- Restart recovers each state deterministically and repeated recovery is idempotent.
- Journal corruption and unsupported schema fail closed.
- Same operation ID is idempotent; a different tenant cannot inspect or resume it.
- Concurrent writers, lock loss, and stale-lock handling.
- Existing audit append failure, rollback failure, and consolidation recovery cases.
- Full unit, architecture, syntax, and Strict CI checks on the final PR head.

## External side effects

No retry may replay an external effect merely because local completion is missing. Each adapter must document provider-enforced idempotency or authoritative reconciliation. If neither is available, preserve an explicit unknown outcome and require safe reconciliation/manual resolution.

## Release gate

Do not enable production asynchronous workers or asynchronous task acceptance until the implementation and all mandatory tests above pass on the final commit, and the provider-aware safety gate tracked by issue #189 is satisfied.
