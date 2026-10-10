# Async side-effect adapter inventory

Status: **blocking for production async activation**

Scope: the production composition rooted at `app.js` on the audited `feat/public-async-task-lifecycle` line. This is a code inventory, not a claim that every possible adapter in the repository or future integrations has been exhaustively proven safe.

## Decision

Keep production task creation synchronous and keep `AsyncWorkflowWorkerService` out of the production composition until every mutating adapter has provider-aware idempotency or authoritative reconciliation, and the exact production shutdown/recovery path has passed integration tests.

A local operation ID, lease, fencing token, JSON transaction, or execution ledger does not prove that an external side effect did not happen before a crash.

## Current production tool inventory

| Tool family / tool | Side effect | Current recovery evidence | Async decision |
| --- | --- | --- | --- |
| `workspace.read`, `workspace.list`, `workspace.search` | Read-only workspace access | No mutation to reconcile | Eligible as read-only, subject to normal authorization and sandbox checks |
| `workspace.propose_changes` | Read-only proposal generation | Does not apply the proposed changes | Eligible as read-only, subject to normal authorization and sandbox checks |
| `project.execute_change` (registered workspace change tool) | Writes a bounded, explicit change set to workspace files | A durable receipt is stored outside the workspace only after verified execution. It binds operation ID, tenant, canonical workspace identity, and normalized changeset hash; atomic write + fsync/rename are used. Reconciliation reports completed only when the receipt matches and the post-state still matches. Missing, corrupt, mismatched, or stale post-state fails closed. | Conditional; receipt and retry tests pass, but lease-loss and full repeated-resume contract coverage remain required. This proves local workspace recovery only, not provider-wide exactly-once semantics. |
| `memory.search`, `memory.list`, `memory.history` | Read-only memory queries (history reads audit state) | No mutation to reconcile | Eligible as read-only, subject to tenant/scope authorization |
| `memory.add` | Mutates memory and its audit record | `MemoryService.reconcileToolOperation` checks durable, tenant/scope-scoped audit receipts such as `memory.created`, `memory.reinforced`, and `memory.archived`; it returns unknown/fail-closed when no authoritative receipt exists. A child-process crash test covers recovery after durable memory commit but before AgentLoop completion persistence. | **Still blocked** until the full adapter contract (especially lease loss, repeated resume, tenant/key collision, and all ambiguous windows) is proven. |
| `memory.delete` | Deletes memory and appends audit state | Uses the same tenant/scope-scoped durable audit receipt reconciliation path as `memory.add`; absence of a receipt does not imply that deletion did not occur and must remain unknown/fail-closed. | **Still blocked** until the full adapter contract is proven for delete, including lease loss, repeated resume, tenant/key collision, and ambiguous outcomes. |
| Network/API, messaging, phone/device, and external process adapters | No such adapter was found in the inspected production tool registrations | Not applicable to the inspected registrations; this is not proof that no dormant code or future adapter exists elsewhere | Any adapter added later must be inventoried and gated before async activation |

## Required adapter contract

For each mutating adapter, add tests for all of the following using a stable tenant-scoped operation ID:

1. Provider or target operation succeeds, then the caller times out before recording local completion.
2. Process crashes after the target operation succeeds but before local completion commit.
3. Retry/resume with the same operation ID.
4. Lease loss while the operation is in flight.
5. Repeated resume after a terminal result.
6. Same key reused by another tenant or distinct operation is rejected or isolated.
7. The target state is ambiguous or cannot be authoritatively queried: return an explicit unknown/conflict outcome and fail closed; never blindly replay.

A test double may prove the adapter contract, but it must model the provider's actual idempotency or authoritative lookup semantics. It must not assume that a local ledger can determine whether a remote side effect occurred.

## Production composition and shutdown

Before activation, an integration test must instantiate the actual production composition and prove this order:

1. Close HTTP ingress.
2. Stop and drain the async worker.
3. Shut down the canonical Runtime.
4. Close persistence.

The inspected composition currently injects no worker into `RuntimeShutdownCoordinator`, consistent with the deliberate synchronous-production boundary. Unit coverage of the coordinator alone does not prove that a future worker has been wired correctly.

## Exit criteria

- [ ] Every registered mutating adapter is listed and classified.
- [ ] Provider idempotency or authoritative reconciliation is documented per adapter.
- [ ] Adapter contract tests cover all failure windows above.
- [x] Memory mutation tools have operation-level audit receipt reconciliation and fail-closed behavior for missing receipts; full adapter contract coverage remains required before activation.
- [ ] Tenant and operation-key isolation is verified at adapter boundaries.
- [ ] Actual production composition shutdown/recovery integration test passes.
- [ ] Strict CI is green on the final commit.
- [ ] Only then may production async activation be considered; it is not authorized by this inventory document.
