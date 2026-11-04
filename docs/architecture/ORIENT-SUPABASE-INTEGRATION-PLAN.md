# ORIENT Optional Supabase Integration — Architecture Decision and Delivery Plan

**Status:** Proposed; implementation gated by target-project selection and database access  
**Date:** 2026-11-05  
**Scope:** Optional cloud services for ORIENT without making Supabase a Runtime dependency

## 1. Decision

ORIENT remains a local-first, governed agent runtime. Supabase may provide optional cloud infrastructure, but it must not own or execute the canonical agent lifecycle.

The current repository already has:
- JSON persistence as the documented default.
- SQLite persistence for local durable storage.
- A PostgreSQL persistence adapter and integration tests.
- A persistence factory that selects `json`, `sqlite`, or `postgres`.

Therefore, do not add a second general-purpose persistence abstraction or replace the existing PostgreSQL adapter with a Supabase-specific database implementation. Supabase PostgreSQL should first be evaluated as a compatible managed PostgreSQL endpoint for the existing adapter.

## 2. Ownership boundaries

| Concern | Canonical owner | Supabase role |
|---|---|---|
| Agent execution, workflow, retries, leases | ORIENT Runtime | None |
| Approval and authorization decisions | ORIENT policy/approval services | Identity claims may be inputs, never authority by themselves |
| Local/offline state | ORIENT SQLite (or configured local adapter) | None |
| Durable cloud persistence | Existing ORIENT PostgreSQL adapter | Managed PostgreSQL hosting, only after schema/tenant review |
| User authentication | ORIENT identity boundary initially | Optional Auth provider behind an adapter, only after lifecycle compatibility tests |
| Cross-device synchronization | ORIENT Sync Engine (to be designed) | Postgres transport/storage; Realtime may notify clients that changes exist |
| Files | ORIENT file metadata and policy | Optional private Storage buckets after access-policy review |
| Realtime | ORIENT event/state contract | Notification transport only; never the source of truth |
| Background jobs | ORIENT durable workflow/worker | Queues may be evaluated later, not substituted for the existing workflow engine |

## 3. Non-negotiable invariants

1. ORIENT starts and performs local tasks when Supabase is unavailable.
2. No Supabase network call occurs on the critical local Runtime execution path.
3. Realtime messages are hints; clients reconcile from durable, tenant-scoped state.
4. Every synchronized record has a stable ID, tenant/owner scope, schema version, and monotonic revision or equivalent conflict token.
5. Sync writes are idempotent and replay-safe; conflicts are explicit and observable, never silently last-write-wins for approvals, executions, or security state.
6. Approval decisions, execution events, leases, and idempotency records are not client-authoritative.
7. No `service_role` or database secret is shipped to browser or Android clients.
8. Every exposed Supabase table has RLS enabled and tested. Authorization must not rely on user-editable JWT metadata.
9. Supabase can be replaced without changes to Domain or Core layers.
10. No production project is resumed, migrated, or modified as part of this architecture-only change.

## 4. Proposed architecture

```text
Android / Web / Desktop
        | local commands
        v
ORIENT Application + Core Runtime
        |
        +---- Local Persistence Adapter (SQLite)
        |
        +---- Sync Outbox / Inbox + Conflict Resolver
                         |
                   Cloud Adapter
                         |
              Existing PostgreSQL adapter
                         |
              Supabase-managed PostgreSQL
                         |
             optional Auth / Storage / Realtime
```

The initial cloud database path should reuse the existing `pg`-based PostgreSQL adapter and its schema/transaction semantics. Do not introduce `supabase-js` merely to execute SQL. Add provider-specific adapters only for capabilities that the existing interfaces cannot express (Auth, Storage, Realtime).

## 5. Delivery phases and gates

### Phase 0 — Baseline audit (read-only)
- Inventory current persistence interfaces, schema/migrations, tenant predicates, auth/session lifecycle, owner bootstrap, file handling, and event streams.
- Compare current PostgreSQL schema and migration history with any selected Supabase project.
- Confirm backup/restore and environment separation.
- Deliverable: verified gap matrix and target-project identification.
- Gate: no schema changes or service activation.

### Phase 1 — Cloud PostgreSQL compatibility (development only)
- Use a dedicated development Supabase project, not production.
- Validate TLS connection, connection pooling strategy, migrations, transaction behavior, indexes, and tenant-scoped repository queries using the existing PostgreSQL adapter.
- Use server-only credentials stored in deployment secrets; prefer a restricted database role.
- Run existing PostgreSQL integration suite against the development project.
- Gate: migrations are repeatable, tenant-isolation tests pass, and rollback/restore is proven.

### Phase 2 — Identity integration (optional, separate adapter)
- Keep ORIENT's authorization and owner/tenant model canonical.
- Map external Supabase Auth subject to an immutable ORIENT identity record.
- Define account linking, first-owner bootstrap, password reset, disable/re-enable, logout, token refresh, session revocation, and account deletion semantics.
- Verify JWT issuer/audience/signature and current session state on sensitive operations; never authorize from user-editable metadata.
- Gate: owner lockout, tenant crossover, stale token, revoked session, and privilege escalation tests pass.

### Phase 3 — Offline-first synchronization
- Define an explicit sync contract and allowlisted entity set; do not sync all database tables.
- Add transactional local outbox, server inbox/deduplication, cursor-based pull, bounded retries, backoff, and tombstones.
- Use deterministic conflict policies by entity type. Approvals, execution state, idempotency, secrets, and audit events are server-authoritative.
- Gate: airplane-mode, reconnect, duplicate delivery, out-of-order delivery, concurrent edits, clock skew, partial upload, and process restart tests pass.

### Phase 4 — Realtime notifications
- Publish only minimal identifiers/revision hints; clients fetch authorized state through the normal API.
- Reconnect using durable cursors; tolerate dropped, duplicated, and reordered notifications.
- Gate: realtime outage does not lose state or block Runtime work.

### Phase 5 — Private file storage
- Store file metadata, owner/tenant, content hash, MIME type, size, retention, and policy in ORIENT.
- Use private buckets and short-lived signed URLs issued only after ORIENT authorization.
- Test tenant isolation, overwrite/upsert behavior, deletion, malware/content validation, and quota limits.
- Gate: no public bucket or cross-tenant file access.

### Phase 6 — Operations and release
- Add health checks, structured logs, metrics, backup/restore drills, data export/deletion, rate limits, cost alerts, and provider outage runbooks.
- Keep cloud features feature-flagged and disabled by default until acceptance.
- Roll out to internal test users, then opt-in cohort; retain a tested local-only mode.

## 6. Required test matrix

- Unit: provider adapter contracts, retry classification, idempotency, conflict resolution.
- Integration: PostgreSQL schema compatibility, migrations, RLS/API access, Auth lifecycle, Storage policies.
- Security: tenant A cannot read/write tenant B; privilege claims cannot be self-assigned; secrets absent from client bundles and logs.
- Resilience: Supabase unavailable, DNS/TLS failure, timeout, rate limit, partial sync, process restart, duplicate/reordered events.
- Product acceptance: local task creation and execution with network disabled; reconnect syncs without duplicate side effects.
- Operational: backup restore, export, deletion, key rotation, cost/usage limits.

## 7. Explicit exclusions for the first release

- No replacement of ORIENT Runtime, Scheduler, Worker, Approval Engine, or Model Router.
- No direct browser/Android access to privileged database credentials.
- No use of Realtime as a durable queue or execution trigger.
- No migration of existing owner identity or production data before a separately reviewed migration plan.
- No automatic resume of an inactive Supabase project until its purpose, owner, cost, data, and environment are confirmed.

## 8. Current verified blockers

- A dedicated ORIENT development Supabase project has now been provisioned and verified:
  - Project ref: `wjbavkwgsyphyzpztyoc`
  - Region: `eu-central-1` (Frankfurt)
  - Status: `ACTIVE_HEALTHY`
  - PostgreSQL: `17.11`
  - Project URL: `https://wjbavkwgsyphyzpztyoc.supabase.co`
- Read-only Phase 0 inspection on 2026-11-05 found zero application tables in `public`, zero recorded migrations, and no security or performance advisor lints. No schema, migration, row, or project configuration was changed during this inspection.
- Supabase's catalog reports five installed extensions on this new project: `plpgsql`, `pgcrypto`, `pg_stat_statements`, `uuid-ossp`, and `supabase_vault`. No ORIENT extension dependency has been enabled.
- The existing PostgreSQL bootstrap is not yet safe to run unchanged against Supabase. `PostgresDatabase.initialize()` executes the complete baseline schema and versioned migrations as part of runtime initialization. It creates tenant-scoped tables but does not enable RLS or define policies. It also performs schema DDL, which should not be granted to the normal runtime identity.
- The MCP SQL inspection connected as `postgres`; this is an administrative role and is not an acceptable production/runtime credential. A separate migration-owner role and a restricted runtime role must be designed before any application schema is deployed.
- Several existing repositories enforce tenant scope in SQL predicates, while owner conversation/profile tables use `owner_id`. A safe RLS design must map the ORIENT authenticated principal to those identifiers and must not assume every table has the same ownership model.
- Supabase's 2026-04-28 Data API change became enforced for all projects on 2026-10-30: newly created public tables are not automatically exposed through Data API. Keep application tables unexposed unless an explicit API surface is approved; this default is defense-in-depth, not a substitute for database-role restrictions and RLS.
- Supabase's 2026-11-04 CLI v3 release changes hosted database command targeting: database commands are local by default, and hosted changes require explicit remote targeting/confirmation. Any future CLI workflow must be verified against the v3 migration guidance and must never assume `db push` targets the hosted project.
- PR #318 remains independent and must be governed by its own exact-head checks. PR #319 remains documentation/architecture work and is not merged.

## 9. Immediate next action

Complete the database security design before the first DDL:
1. Define an explicit ORIENT-to-database identity contract for `tenant_id` and `owner_id`.
2. Separate schema migration ownership from the restricted application runtime role.
3. Decide whether RLS is driven by transaction-local trusted tenant context or by signed Supabase Auth claims. Do not use client-editable metadata or caller-controlled session variables.
4. Update the existing PostgreSQL adapter so runtime initialization does not silently perform migrations; add an explicit, auditable migration command/path.
5. Add tests proving tenant isolation, role privilege boundaries, migration repeatability, and local-only operation.
6. Only then create and apply a reviewed, versioned Supabase migration to this empty development project, followed by advisors and end-to-end integration tests.

Until those gates pass, do not run `PostgresDatabase.initialize()` against the Supabase project, do not expose application tables through the Data API, and do not place any database credential in the repository or client applications.
