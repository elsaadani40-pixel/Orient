# PostgreSQL Worker Principal Audit

Date: 2026-11-08

## Scope and current truth

This audit covers the asynchronous workflow worker path, its PostgreSQL registry, dispatch claims, workflow leases, workflow persistence, and tenant quota repository. It is separate from the owner-principal task/execution/approval slice.

The current implementation has useful lifecycle controls, but tenant scoping and random worker identifiers are not an authorization principal:

- `AsyncWorkflowWorkerService` generates or accepts a `workerId`, registers it, heartbeats it, and passes only the worker ID and capability list to recovery/worker factories.
- `AsyncWorkflowWorker` also supports direct registration and heartbeat. It calls `scheduler.leaseAsync(workerId, capabilities)`; the worker identity is not represented by a trusted immutable object.
- `PostgresWorkerRegistryRepository` scopes register, heartbeat, unregister, find, reap, and count by tenant and worker ID. It does not verify a worker principal or worker session.
- `PostgresWorkflowRepository.claimQueued` checks that the worker row exists, is READY, unexpired, and has the registered capabilities. It then writes dispatch claims using a plain worker ID.
- `PostgresWorkflowLeaseRepository.tryAcquire` checks workflow state and writes a lease with worker ID and fencing token. Renewal, lookup, and release are scoped by tenant/workflow/lease ID, not a trusted worker principal.
- `PostgresWorkflowRepository.save` checks an active fencing token for leased writes, but its predicate does not bind the write to the lease's worker ID and lease ID. Initial/unleased writes are tenant-scoped only.
- `PostgresTenantQuotaRepository` operates at tenant scope. Those operations are service-level admission/cleanup operations and must not be silently treated as owner or worker actions.
- `WorkflowInstance` persists `tenantId` and `userId`; the workflow owner is therefore available in durable workflow state, but no delegated worker-to-owner persistence authority is currently established by the worker lease.

## Foundation added in this slice

- Added an immutable, in-process `WorkerPersistencePrincipal` with tenant, worker, worker-session, normalized capabilities, and optional workflow/lease/fencing binding.
- Added `PostgresDatabase.transactionWithWorkerPrincipal`, which establishes worker-specific transaction-local context on one checked-out client and always commits/rolls back and releases that client.
- Added unit coverage for untrusted-object rejection, immutable identity, all-or-nothing lease binding, transaction-local context, and rollback.

This is an authority primitive only. It is not yet wired into worker registration, dispatch, leases, or workflow writes and does not claim worker isolation.

## Required end-state protocol

1. **Worker session issuance:** only the trusted worker bootstrap creates a worker principal. Every process boot gets a new session ID. A worker ID alone is never accepted as authority.
2. **Registration and heartbeat:** registry writes require the matching tenant/worker/session principal; registration cannot overwrite a live different worker session without an explicit stale-session/fencing rule.
3. **Dispatch claim:** claim creation and release require the same worker principal and registered capability set. Claim rows must be bound to worker session and expiry.
4. **Lease binding:** after durable lease acquisition, mint a lease-bound worker principal containing workflow ID, lease ID, and fencing token. Every renew/assert/release operation must verify all of them and the worker session.
5. **Workflow writes:** leased workflow writes must match workflow ID, tenant, worker ID, lease ID, fencing token, and unexpired lease in the same transaction. A stale worker must not mutate a newer worker's workflow.
6. **Delegated owner authority:** a worker may act on an owner's execution only through a durable workflow-to-execution relation and a lease-bound delegation check. The worker must not invent or infer owner identity from request input or mutable process state.
7. **Tenant quota/system operations:** define a separate trusted system/service principal for quota admission, reservation cleanup, and global maintenance. Do not reuse owner or worker principals for these operations.
8. **RLS gate:** do not activate RLS policies or switch production credentials until worker/session/lease/delegation predicates are enforced and tested on the real PostgreSQL path.

## Required adversarial verification

- Two workers in one tenant cannot heartbeat, claim, renew, release, or mutate each other's work.
- A worker from another tenant cannot inspect or mutate worker, claim, lease, workflow, or quota rows.
- A restarted worker session cannot reuse the previous session's authority.
- Expired leases, replaced leases, and stale fencing tokens fail closed.
- Concurrent claims and lease acquisition remain single-winner under `SKIP LOCKED` and transaction races.
- Rollback, connection-pool reuse, and worker shutdown do not leak transaction-local identity.
- Delegated execution writes match the durable workflow owner and the active worker lease.
- System maintenance authority is distinct from both owner and worker authority.

## Explicitly not changed

No worker registry or workflow repository behavior is changed by this audit foundation. No hosted Supabase roles, grants, RLS policies, production credentials, or Vercel settings are changed.
