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


## Additional identity-binding finding: owner ID is not bound to runtime identity

A follow-up trace of the production composition on this branch found a second identity consistency gap:

- `app.js` constructs `OrientRuntime` with `tenantId`, but does not supply `userId`; `OrientRuntime` therefore defaults `this.userId` to `local`.
- The same composition calls `createServer` with the trusted configured `tenantId` and hard-coded `ownerId: 'owner'`.
- `server.js` issues the persistence principal from that trusted `ownerId` and authenticated session.
- `AgentService.createTask` currently validates principal issuance, tenant, and session, but does not bind `principal.ownerId` to a canonical runtime/request owner identity.
- The request execution context consequently uses the runtime's `userId` (`local`) rather than the principal's owner identity (`owner`).

This is not a caller-controlled identity injection in the current production composition, because the principal's owner ID comes from trusted server configuration. It is nevertheless an identity-model inconsistency: durable owner-scoped authorization cannot be proven end-to-end while the task's runtime identity and persistence principal owner differ.

### Required correction before owner-scoped execution persistence

1. Establish one canonical owner identity in the production composition root and pass it consistently to both `OrientRuntime.userId` and `createServer.ownerId`.
2. Make the authenticated request boundary bind the exact issued principal to the request execution context; do not reconstruct identity from `ownerSessionContext`.
3. Reject mismatched tenant/owner/session before any idempotency or execution SQL.
4. Add composition tests proving runtime owner ID equals principal owner ID, plus two-owner same-tenant isolation tests.
5. Keep non-owner/system work on an explicit worker/system identity path rather than silently inheriting the owner identity.

Do not infer that changing only `userId` fixes persistence isolation. Repository-level principal transactions and owner-scoped reads/writes remain unimplemented.


## Follow-up verification: owner identity admission hardening

Audit target: latest PR #350 head after the owner-principal admission tests (2026-11-08).

The production composition identity mismatch recorded above is corrected in the branch: `app.js` supplies the same canonical `owner` value to `OrientRuntime.userId` and `createServer.ownerId`. The composition integration test asserts the Runtime identity and passes it as the server owner identity.

A further fail-closed check is now added at `AgentService.createTask`:

- An owner-session task without a validated persistence principal is rejected before idempotency admission.
- The issued principal must match the authenticated session, Runtime tenant, and Runtime owner identity.
- A valid principal issued for a different owner in the same tenant is rejected before repository admission.
- Unit tests cover missing principal, cross-owner principal, and the accepted matching-principal path.

This closes the **task-creation admission identity check only**. It does not yet bind the principal to the Runtime execution, execution repository, events, checkpoints, resume/cancel, or owner-scoped reads. The runtime still owns a singleton persistence coordinator configured with tenant identity only, so a principal must not be placed on that singleton or inferred from mutable execution metadata.

The next implementation slice remains the full request-scoped lifecycle propagation and repository migration described above. Exact-head CI must complete on the latest commit before treating these changes as verified. PR #350 remains Draft; no RLS policies, hosted grants, roles, or production credentials are changed.


## Follow-up verification: PR #351 owner-scoped read slice

Audit target: PR #351 head `1caa2771c6f801664972d2b02b5a0240ac768c96` (2026-11-08).

The following read paths now carry the exact server-issued principal from the authenticated HTTP request into the PostgreSQL repository boundary:

- Task list and execution history: `AgentService.listExecutionSummaries` → `OrientRuntime.listExecutionSummaries` → `PostgresExecutionRepository.findPage/findAll`.
- Task status: `AgentService.getExecutionStatus` → `OrientRuntime.getExecutionStatus` → `PostgresExecutionRepository.findById`.
- Task event history and SSE: `AgentService.getExecutionEvents` → `OrientRuntime.getExecutionEvents` → `PostgresEventRepository.findByExecutionId`.
- Final answer: status, execution evidence lookup, and idempotent answer persistence receive the same principal.
- Execution approval listing first verifies that the referenced execution is visible to the authenticated owner before listing approvals for that execution.

For principal-scoped execution reads, SQL includes the execution payload owner identity (`payload->>'userId'`) and runs through `transactionWithPrincipal`. Event history is constrained by an ownership-checked execution existence query. Both count and page queries use the same principal-scoped transaction client. Legacy non-principal calls retain their existing query shape for compatibility; they are not considered owner-isolated and must not be used for authenticated production reads.

Exact-head CI on this PR revision completed successfully: Unit + Architecture (Node 22 and Node 24), Full Repository Test Suite (Node 24 + PostgreSQL), PostgreSQL Integration (Node 22), Android Companion, Static Safety Checks, CodeQL, Owner Dashboard (Chromium), and Gitleaks.

### Still not closed

- Execution insert/update/cancellation writes and recovery reconciliation.
- Event append and appendMany writes.
- Checkpoint history and resume-lease lifecycle.
- Resume, cancel, and approval decision mutations.
- Pending approval inbox ownership.
- Workflow, worker, dispatch-claim, worker-registry, and tenant-quota principal separation.
- Full atomicity across execution, events, checkpoints, idempotency, and approval state.
- RLS policy activation and hosted database role/grant/credential changes.

This is a successful read-path sub-slice only. PR #351 remains Draft and is stacked on PR #350; neither PR claims complete owner isolation. The RLS activation gate remains closed until every lifecycle path has explicit owner or worker principal authority and adversarial cross-owner, cross-tenant, rollback, pool-reuse, and concurrency tests pass.
