# PostgreSQL Principal Propagation Contract

## Status

This document is an implementation contract for the PostgreSQL tenant-isolation hardening work. It does not authorize enabling RLS policies, changing hosted database roles, or switching production credentials.

## Current verified boundary

- Authenticated owner HTTP requests can produce an immutable persistence principal containing `tenantId`, `ownerId`, and `sessionId`.
- The principal factory tracks issued objects and rejects plain caller-created objects.
- `PostgresDatabase.transactionWithPrincipal(principal, work)` validates that object and sets transaction-local PostgreSQL settings on the same checked-out client:
  - `app.orient_tenant_id`
  - `app.orient_owner_id`
  - `app.orient_session_id`
- Owner chat and owner work-profile repositories already require a validated principal and execute through that transaction helper.
- The other durable repositories still contain direct pool-level queries and ordinary transactions. Tenant SQL parameters alone are not a substitute for a trusted database principal or RLS context.
- The hosted Supabase schema has RLS enabled but no policies. This is intentionally fail-closed for untrusted client roles; do not add policies before the full runtime and worker principal path is complete.

## Non-negotiable invariants

1. **Identity provenance:** tenant and owner identity must be derived from authenticated server-side state or explicit trusted worker configuration. Never accept tenant, owner, or session identity from request body, query string, or caller-controlled headers.
2. **Immutable principal:** every protected operation receives an object created by the principal factory. Plain objects and reconstructed identities are rejected.
3. **One connection per logical operation:** all SQL in a protected operation, including reads before writes and nested repository work, must execute on the same checked-out client inside `transactionWithPrincipal`.
4. **No ambient identity:** do not store a principal in a process-global variable, singleton, async-unsafe mutable context, or reusable pool connection.
5. **Worker separation:** schedulers, recovery loops, workflow dispatchers, and workers use a separately issued, least-privilege worker/system principal. They must not borrow an owner browser session.
6. **Tenant and owner scope:** tenant-owned data is scoped by tenant and, where applicable, owner. Session identity is request authorization context, not a partition key for durable owner data.
7. **Atomic transitions:** idempotency, approval decisions/consumption, lease acquisition/renewal, checkpoint sequence allocation, cancellation, and workflow fencing retain their existing atomicity and concurrency guarantees after principal propagation.
8. **Fail closed:** missing, forged, mismatched, or unsupported principals fail before protected SQL executes.

## Repository migration inventory

The current PostgreSQL persistence adapter exposes these protected repository families:

- Executions
- Events
- Idempotency
- Checkpoints and execution-resume leases
- Workflows and dispatch claims
- Workflow leases
- Approvals
- Tenant quotas
- Worker registry
- Owner chat
- Owner work profiles

Owner chat and owner work profiles are the completed reference implementations. The remaining families must be migrated as a coordinated API change; do not mark the database RLS-ready while any protected repository can still use pool-level `query()` or an ordinary transaction.

For each repository method, record:
- principal kind accepted (owner or worker/system);
- identity fields used and their trusted source;
- every SQL statement and whether it uses the principal transaction client;
- cross-tenant and cross-owner behavior;
- transaction/locking/CAS semantics;
- failure behavior when the principal is missing or invalid.

## Required adversarial verification

### Principal validation
- Reject missing principal, plain object, frozen-but-forged object, mutated/reconstructed identity, invalid identifiers, and principal from an unsupported issuer.
- Reject caller-supplied tenant/owner/session values that disagree with the validated principal.
- Ensure all validation failures occur before SQL.

### Connection and concurrency isolation
- Interleave two tenants and two owners on a pool with a small connection limit.
- Assert transaction-local settings remain stable throughout each transaction.
- Assert settings do not leak after commit, rollback, thrown callback, or connection reuse.
- Assert a repository cannot issue a protected query through the pool while a principal transaction is active.

### Lifecycle and recovery
- Verify worker/system principal issuance and revocation/expiry semantics.
- Verify queued-work claiming, lease fencing, approval pause/resume, cancellation, checkpoint recovery, and restart behavior.
- Verify idempotent replay and immutable approval decisions under concurrent requests.
- Verify rollback leaves no partial state and retries do not duplicate side effects.

### Database role and RLS gate
Do not enable application RLS policies, remove the legacy tenant default, grant new hosted privileges, or switch runtime credentials until all of the following are proven:
- every protected repository method is principal-bound;
- all HTTP entry points propagate authenticated owner principals;
- all background execution paths use explicit worker/system principals;
- runtime login is least-privilege and is not a member of the owner/migrator roles;
- adversarial PostgreSQL integration tests pass against the intended runtime role;
- startup, migration, shutdown, and recovery behavior are verified with that role.

## Completion evidence

The hardening task is complete only when the PR includes:
- a method-by-method repository inventory with no unclassified protected SQL;
- tests for missing/forged/cross-tenant/cross-owner principals;
- pool interleaving, rollback, and connection-reuse tests;
- worker identity and restart/recovery tests;
- exact-head CI success on the proposed commit;
- a post-merge verification report tied to the resulting `main` SHA.

A green unit suite alone, a provisioned schema, or RLS being enabled without policies does not satisfy this gate.
