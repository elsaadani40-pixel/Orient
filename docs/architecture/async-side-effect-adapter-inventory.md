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
| `project.execute_change` (registered workspace change tool) | Writes a bounded, explicit change set to workspace files | Has a read-after-crash `reconcile` handler. It reports completion only when all proposed final contents are present; partial, conflicting, or untouched state must not be blindly replayed. This is local filesystem reconciliation, not an external provider guarantee. | Conditional; retain contract tests for fully applied, partially applied, untouched, conflicting, retry, and lease-loss cases |
| `memory.search`, `memory.list`, `memory.history` | Read-only memory queries (history reads audit state) | No mutation to reconcile | Eligible as read-only, subject to tenant/scope authorization |
| `memory.add` | Mutates memory and its audit record | The memory transaction coordinator protects memory/audit crash consistency, but this tool has no operation-level `reconcile` handler proving whether a particular async operation already committed | **Blocked** until stable operation identity and authoritative operation-level reconciliation/deduplication are implemented and tested |
| `memory.delete` | Deletes memory and appends audit state | Same limitation as `memory.add`; crash-consistent files do not prove the async step outcome | **Blocked** until stable operation identity and authoritative operation-level reconciliation/deduplication are implemented and tested |
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
- [ ] Memory mutation tools are gated until their operation outcome is reconcilable.
- [ ] Tenant and operation-key isolation is verified at adapter boundaries.
- [ ] Actual production composition shutdown/recovery integration test passes.
- [ ] Strict CI is green on the final commit.
- [ ] Only then may production async activation be considered; it is not authorized by this inventory document.
