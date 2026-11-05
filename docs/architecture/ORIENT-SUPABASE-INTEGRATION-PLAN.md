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
- **Tests added/updated:** lifecycle unit tests assert startup performs no DDL and fails closed when the schema is absent/outdated; the real-PostgreSQL integration test calls `migrate()` explicitly before verifying schema idempotency. On branch head `a4352747a7f65761e8f5c9a4752a4223ea5f8c68`, Strict CI (all 6 jobs), Browser Acceptance, CodeQL, and Secret Scanning passed. The PostgreSQL integration suite passed 22/22 tests, including duplicate-grantor membership normalization and runtime role least-privilege assertions.
- **Implemented on the integration branch:** a stable owner UUID and immutable internal Runtime principal are derived from local ORIENT identity state and trusted server configuration; request-supplied tenant/owner fields are not authoritative.
- **Implemented on the integration branch:** every repository exposed by `PostgresPersistence` is bound to the internal principal and executes through the transaction-scoped context boundary.
- **Implemented on the integration branch:** dedicated `orient_owner`, `orient_migrator`, `orient_runtime`, and `orient_runtime_login` roles, plus version-9 entity-specific tenant/owner RLS policies and restricted grants. Migration role elevation uses transaction-local `SET LOCAL ROLE`.
- **Implemented and verified in CI:** application startup rejects PostgreSQL connections unless both `session_user` and `current_user` are `orient_runtime_login`, the login inherits `orient_runtime`, and it has no owner membership, elevated role attributes, CREATE privilege on any non-system schema, or ownership of application relations. A real PostgreSQL 17 integration test connects with a newly provisioned runtime password, performs read-only schema initialization, and verifies that a transaction-local role switch is reset before the pooled connection is reused.
- **Security limitation:** policies use transaction-local custom PostgreSQL settings. These protect against omitted tenant predicates and accidental cross-scope queries, but they are not cryptographic authentication and do not defend against arbitrary SQL or a compromised application process that can call `set_config()`. A database-verifiable signed-principal mechanism remains a decision gate if that threat is in scope. See [ORIENT-SUPABASE-IDENTITY-RLS-READINESS.md](./ORIENT-SUPABASE-IDENTITY-RLS-READINESS.md).
- **Not yet verified against hosted Supabase:** provisioning the roles, applying version-9 migrations, runtime login restrictions, complete grants/advisor review, and connection-pool behavior using the actual hosted credentials. No hosted changes have been performed.
- The MCP inspection role was `postgres`, an administrative role. It must not be used as the normal application runtime credential.
- Supabase CLI v3 (released 2026-11-02) defaults database commands to the local stack; hosted database changes require explicit `--remote` targeting and confirmation. See the [CLI v3 migration guide](https://supabase.com/docs/guides/local-development/cli/migrating-to-v3).
- PR #318 remains independent. PR #319 remains Draft and unmerged.

## 9. Next security gate

Before applying the migration to hosted Supabase:
1. Confirm the intended threat boundary: the current GUC design protects against accidental cross-scope access, not arbitrary SQL under the runtime credential. Decide whether signed database-verifiable principal context is required before hosted use.
2. Run role provisioning and migrations against disposable/local PostgreSQL 17 using the exact restricted login topology; verify migration role elevation cannot leak across pooled connections.
3. Verify the actual `orient_runtime_login` credential cannot own tables, bypass RLS, create schema objects, or read/write migration metadata.
4. Review every grant, policy, exposed schema, and Supabase Data API setting; keep application tables unexposed unless explicitly reviewed.
5. Run the full integration suite and Supabase security/performance advisors against the development target.
6. Only after explicit approval, apply the reviewed migration to the empty Supabase development project and repeat the grant/RLS/advisor verification.

Until those gates pass, do not run `npm run db:migrate` against the Supabase project, do not expose ORIENT tables through the Data API, and do not place credentials in source control or client applications.
