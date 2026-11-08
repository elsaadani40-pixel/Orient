# PostgreSQL Repository Principal Audit

Audit target: `main` at `26b1409883f47e2dcc241a8522e067f754a08783` (2026-11-08).

This is a source-level inventory, not a claim that the listed operations have already been migrated. Counts are occurrences of `this.db.query(`, `this.db.transaction(`, and `this.db.transactionWithPrincipal(` within each repository implementation. Calls through local transaction clients are not counted as pool-level calls.

| Repository | Methods | Pool query calls | Ordinary transaction calls | Principal transaction calls |
|---|---:|---:|---:|---:|
| Execution | 9 | 14 | 0 | 0 |
| Events | 8 | 10 | 1 | 0 |
| Idempotency | 8 | 6 | 0 | 0 |
| Checkpoints / resume leases | 10 | 9 | 1 | 0 |
| Workflows / dispatch claims | 9 | 10 | 2 | 0 |
| Workflow leases | 8 | 9 | 1 | 0 |
| Approvals | 8 | 9 | 0 | 0 |
| Worker registry | 9 | 7 | 0 | 0 |
| Tenant quotas | 9 | 6 | 2 | 0 |
| Owner chat | 5 | 0 | 0 | 5 |
| Owner work profile | 2 | 0 | 0 | 2 |

## Method inventory

- **Execution:** `findById`, `findAll`, `findPage`, `findByGoalId`, `insert`, `update`, `requestCancellation`, `deleteById`, `count`.
- **Events:** `append`, `appendMany`, `findAll`, `findByExecutionId`, `findByGoalId`, `findByType`, `count` (plus normalization).
- **Idempotency:** `findByKey`, `find`, `begin`, `complete`, `fail`, `delete`, `count` (plus key construction).
- **Checkpoints / resume leases:** `save`, `findLatest`, `acquireResumeLease`, `renewResumeLease`, `releaseResumeLease`, `delete`, `count` (plus serialization/digest/model conversion).
- **Workflows:** `save`, `claimQueued`, `releaseDispatchClaim`, `requestCancellation`, `findById`, `findByApprovalExecutionId`, `findAll`, `delete`, `count`.
- **Workflow leases:** `tryAcquire`, `save`, `renewIfOwned`, `findByWorkflowId`, `findAll`, `delete`, `deleteExpired`, `count`.
- **Approvals:** `findByExecution`, `findPending`, `save`, `findById`, `consume`, `recordDecision`, `count` (plus row mapping).
- **Worker registry:** `register`, `heartbeat`, `unregister`, `findById`, `findAll`, `reapExpired`, `count`.
- **Tenant quotas:** `ensureTenant`, `reserveWorkflow`, `promoteWorkflow`, `recoverWorkflow`, `queueWorkflow`, `refreshWorkflow`, `releaseWorkflow`, `snapshot`.

## Migration order and special handling

1. **Execution + Events:** propagate owner principals for HTTP-originated work and worker principals for background/recovery work. Preserve cancellation CAS behavior, deterministic event ordering, append idempotency, and tenant-scoped pagination.
2. **Idempotency:** principal-bind key lookup and all begin/complete/fail/delete paths. Keep unique tenant-key constraints and concurrent begin semantics atomic.
3. **Checkpoints + resume leases:** principal-bind snapshot history and lease lifecycle. Preserve advisory-lock sequence allocation, digest validation, fencing, expiry, and recovery.
4. **Workflows + dispatch claims + workflow leases:** distinguish owner-created operations from worker claims. Claims, fencing tokens, lease renewals, and release must remain atomic on one transaction client.
5. **Approvals:** owner principal for decisions and pending/history reads; worker principal for execution-side approval consumption where authorized. Keep immutable decision semantics and atomic consume.
6. **Worker registry + tenant quotas:** require an explicit worker/system principal. Do not infer tenant from a worker-supplied metadata object. Preserve admission-control and reservation locks.

## Important caveat

The current database exposes `query()` and `transaction()` without principal requirements because migrations and bootstrap code still need controlled access. This means repository enforcement must be explicit and complete before RLS policies are enabled. A method accepting a `tenantId` SQL parameter is not considered principal-protected.

## Acceptance gate

For each migrated method, tests must prove: no principal means no SQL; forged principal means no SQL; caller identity mismatch is rejected; cross-tenant/owner access is denied; all statements in the operation use one checked-out client; rollback and pool reuse do not leak context; and concurrent approval/idempotency/lease races retain their invariants.

No hosted Supabase policies, role grants, production credentials, or runtime connection settings are changed by this audit.
