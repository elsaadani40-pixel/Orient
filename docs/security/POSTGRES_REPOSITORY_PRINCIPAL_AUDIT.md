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

## HTTP-to-runtime propagation gap confirmed

A source trace on the audited `main` confirms an additional boundary gap:

- `src/interfaces/http/server.js` creates the validated owner persistence principal and passes it as the fifth argument to `agentRoutes.createTask(...)`.
- `src/interfaces/http/routes/agent.routes.js` accepts that fifth argument, but the call to `agentService.createTask(...)` forwards only `goal`, `idempotencyKey`, and `ownerSessionContext`. The validated principal is not forwarded to the service.
- `src/application/agent/agent.service.js` validates the owner session but calls `idempotency.begin/complete/fail` with tenant identifiers only. Those calls do not receive a validated persistence principal.
- `src/core/runtime/request-execution-coordinator.js` accepts the owner session context and validates it, but constructs the execution context with tenant/user/workspace metadata; it does not accept or propagate the persistence principal to execution/event/checkpoint repositories.

Therefore the owner principal currently protects the owner chat/profile persistence boundary but does not yet protect task idempotency or the execution lifecycle. A valid session ID in runtime metadata is not equivalent to a validated persistence principal object. Do not infer principal authority from `ownerSessionContext` or `context.metadata`.


- `src/core/runtime/execution-persistence-coordinator.js` is the persistence choke point for execution snapshots, event batches, and checkpoints. Its current constructor stores persistence and tenant only; `persistEvents`, `persistExecution`, and `checkpoint` pass tenant options but no principal. Updating only the HTTP route or AgentService would therefore still leave the execution lifecycle unbound.
- `src/core/runtime/request-execution-coordinator.js` validates the owner session and creates execution context metadata containing the session ID, but it does not carry a persistence-principal object into the persistence coordinator. Durable resume also reads checkpoints and executions with tenant options only.

This is a concrete prerequisite for the first migration slice: route → AgentService → Runtime/RequestExecutionCoordinator → PersistenceCoordinator → Execution/Events/Idempotency/Checkpoints must carry one validated principal for owner-originated operations, while worker-originated operations must use a separately issued worker principal. The task-creation route must forward the principal explicitly; it must not reconstruct one from the session context.

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


## Follow-up verification: PR #350 head

Audit target: `65a56723d1cac1f68777cea342c527455372210d` (2026-11-08).

The earlier HTTP-to-idempotency gap is partially closed on this branch:

- `server.js` passes the server-issued principal to `agentRoutes.createTask`.
- `agent.routes.js` forwards that exact object to `AgentService.createTask`.
- `AgentService` validates issuance and rejects session/tenant mismatch before idempotency admission.
- The PostgreSQL idempotency begin/complete/fail methods use `transactionWithPrincipal` when the validated principal is supplied. The non-principal compatibility path remains available and is not RLS-safe.

The following execution-lifecycle gaps remain confirmed at this head:

1. **Runtime handoff:** `AgentService.createTask` calls `this.execute(clean, { ownerSessionContext })`; it does not pass `persistencePrincipal` to `OrientRuntime.execute`.
2. **Shared persistence coordinator:** `ExecutionPersistenceCoordinator` is constructed once with the runtime's fixed `tenantId`. Its `persistExecution`, `persistEvents`, and `checkpoint` methods pass tenant options only, not a principal.
3. **Execution repository:** execution reads, inserts, updates, cancellation writes, deletes, counts, and pagination still use pool-level `db.query` calls and accept tenant filters rather than a validated principal.
4. **Events/checkpoints/resume leases:** these repositories remain outside `transactionWithPrincipal`; event append and checkpoint/lease operations are not principal-bound.
5. **Resume and cancellation:** `RequestExecutionCoordinator.resume` and `OrientRuntime.cancelExecution` use the runtime tenant for checkpoint, execution, and lease operations. They do not receive an owner principal.
6. **Owner reads:** task list/status/events/final-answer/approval reads are scoped to the runtime tenant and are not explicitly owner-principal-bound at their repository boundary.
7. **Approvals/workflows/workers/quotas:** these remain separate migration families. Owner decisions and worker-side consumption/dispatch must use distinct trusted principal types.

### Required next vertical slice

Do not solve this by putting a principal on the singleton runtime or in mutable ambient state. Pass an immutable request-scoped owner principal explicitly through the service and request coordinator into every persistence operation. Background execution, recovery, workflow dispatch, and workers must receive a separately issued worker/system principal. Reads as well as writes must be covered.

The slice must preserve single-client transaction scope and existing CAS/locking/fencing guarantees for execution state, event batches, checkpoints, resume leases, cancellation, and restart recovery. Add adversarial tests for two owners in one tenant, two tenants on a constrained pool, forged/missing/mismatched principals, cross-owner reads, rollback, connection reuse, and worker/owner separation.

PR #350 is therefore a successful idempotency sub-slice only. It does not close the execution lifecycle or satisfy the RLS activation gate. No hosted RLS policy, role, grant, or production credential change is authorized by this audit.
