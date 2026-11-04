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

## 8. Current verified blockers and implementation status

- Dedicated ORIENT development project:
  - Project ref: `wjbavkwgsyphyzpztyoc`
  - Region: `eu-central-1` (Frankfurt)
  - Status at Phase 0 inspection: `ACTIVE_HEALTHY`
  - PostgreSQL: `17.11`
  - Project URL: `https://wjbavkwgsyphyzpztyoc.supabase.co`
- Phase 0 found zero application tables in `public`, zero recorded migrations, and no security or performance advisor lints. No Supabase schema, data, migration, extension, or project setting was changed.
- **Implemented on the integration branch:** `PostgresDatabase.initialize()` now performs read-only schema readiness/version checks. It no longer creates tables or runs migrations during application startup.
- **Implemented on the integration branch:** explicit schema migration is exposed through `PostgresDatabase.migrate()`, `PostgresPersistence.migrate()`, and the factory's `migrate()` method. The operator command is `ORIENT_MIGRATION_DATABASE_URL=... npm run db:migrate`; it requires a deliberate operator invocation and does not run automatically during app startup.
- **Tests added/updated:** lifecycle unit tests assert startup performs no DDL and fails closed when the schema is absent/outdated; the real-PostgreSQL integration test now calls `migrate()` explicitly before verifying schema idempotency. CI results for this code revision are still pending.
- **Not yet implemented:** separate migration-owner and restricted runtime database roles, entity-specific RLS policies, trusted tenant/owner identity context, and connection-pool context isolation tests.
- The existing schema contains both `tenant_id` and `owner_id` ownership models. A generic `auth.uid()` policy or caller-controlled session variable would not be a valid substitute for an explicit ORIENT identity contract.
- A dedicated repository audit now confirms the current owner login is a single local `Admin` identity persisted in `owner.json`, not a Supabase Auth principal; the runtime tenant is currently process-configured by `ORIENT_TENANT_ID` (default `local`). The PostgreSQL adapter also issues ordinary reads/writes through `pool.query()` rather than a mandatory trusted tenant-scoped transaction. Therefore neither `auth.uid()` nor an unsigned `current_setting('app.tenant_id')` policy is safe to introduce yet. See [ORIENT-SUPABASE-IDENTITY-RLS-READINESS.md](./ORIENT-SUPABASE-IDENTITY-RLS-READINESS.md).
- The MCP inspection role was `postgres`, an administrative role. It must not be used as the normal application runtime credential.
- Supabase CLI v3 (released 2026-11-02) defaults database commands to the local stack; hosted database changes require explicit `--remote` targeting and confirmation. See the [CLI v3 migration guide](https://supabase.com/docs/guides/local-development/cli/migrating-to-v3).
- PR #318 remains independent. PR #319 remains Draft and unmerged.

## 9. Next security gate

Before applying any schema to Supabase:
1. Define a trusted ORIENT principal/tenant identity contract for both `tenant_id` and `owner_id`.
2. Create distinct migration-owner and restricted runtime roles; grant the runtime role only required DML and sequence privileges, without schema ownership, superuser, or RLS bypass.
3. Choose a database-verifiable transaction-scoped identity propagation design. Never trust caller-controlled tenant session variables or editable user metadata.
4. Add entity-specific RLS and explicit grants; test SELECT/INSERT/UPDATE/DELETE and cross-tenant/owner denial.
5. Test transaction-local context reset under pooled connection reuse.
6. Run the migration and integration suite against disposable/local PostgreSQL 17, then run security/performance advisors.
7. Only after review, apply a versioned migration to the empty Supabase development project.

Until those gates pass, do not run `npm run db:migrate` against the Supabase project, do not expose ORIENT tables through the Data API, and do not place credentials in source control or client applications.
