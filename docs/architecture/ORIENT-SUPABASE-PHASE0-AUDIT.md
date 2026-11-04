# ORIENT Supabase Phase 0 — Read-only Database Audit

**Audit date:** 2026-11-05  
**Target:** Dedicated ORIENT development project  
**Project ref:** `wjbavkwgsyphyzpztyoc`  
**Region:** `eu-central-1` (Frankfurt)  
**PostgreSQL:** `17.11`  
**Audit mode:** Read-only; no DDL, DML, migration, extension activation, or project setting changes

## Executive result

The dedicated project is active and healthy, and its application database is empty. It is suitable as the development target for a carefully gated compatibility phase. It is **not yet safe to point the current ORIENT runtime at it**, because the current PostgreSQL initialization path performs schema DDL and does not establish RLS policies.

## Verified Supabase state

| Check | Observed result |
|---|---|
| Project status | `ACTIVE_HEALTHY` |
| Database | `postgres` |
| Server role used for MCP inspection | `postgres` (administrative; not a runtime credential) |
| Public application tables | 0 |
| Recorded migrations | 0 |
| Installed extensions | 5 |
| Security advisor lints | 0 |
| Performance advisor lints | 0 |
| Project URL | `https://wjbavkwgsyphyzpztyoc.supabase.co` |

Installed extensions reported by Supabase: `plpgsql`, `pgcrypto`, `pg_stat_statements`, `uuid-ossp`, and `supabase_vault`. The audit did not enable or modify any extension.

Advisor results are a point-in-time scan, not a security certification. Empty tables and clean advisor output do not prove the future application schema is secure.

## Verified ORIENT repository state

The repository already includes:
- `pg` as its PostgreSQL client dependency.
- An existing PostgreSQL persistence adapter and a persistence factory.
- A PostgreSQL schema bootstrap and versioned migrations embedded in `src/infrastructure/persistence/postgres/postgres-database.js`.
- PostgreSQL integration tests in `test/integration/postgres-persistence.integration.test.js` and `test/integration/postgres-task-idempotency.integration.test.js`.
- `.env.example` documents `ORIENT_PERSISTENCE=json` by default and `ORIENT_DATABASE_URL` for opt-in PostgreSQL mode.

The schema bootstrap includes tenant-bearing tables such as executions, events, idempotency, checkpoints, workflows, approvals, worker nodes, and quota records. Owner chat/profile tables use `owner_id` rather than the same `tenant_id` model.

## Security and compatibility findings

### P0 — Runtime initialization is also a schema migration path

`PostgresDatabase.initialize()` opens a transaction, obtains an advisory transaction lock, executes the baseline schema, and applies pending migration SQL. This is convenient for integration tests, but it means ordinary runtime startup can perform DDL.

**Required correction:** separate explicit schema migration from runtime initialization. The application runtime must not need schema-owner privileges.

### P0 — No RLS policy model is present in the current schema bootstrap

The current schema creates application tables but does not enable RLS or define tenant/owner policies. Tenant predicates in repository SQL are useful application-level controls, but they are not an independent database authorization boundary.

**Required correction:** design RLS per entity and ownership model, then add tests for cross-tenant reads/writes. Do not enable a generic policy that assumes all rows have `tenant_id`.

### P0 — Administrative inspection role is not an application credential

The read-only SQL tool reported `current_user = postgres`. This is the administrative context used for inspection. It must not be copied into `ORIENT_DATABASE_URL` for a deployed runtime.

**Required correction:** provision separate migration-owner and restricted runtime database roles. Runtime role must have only the DML privileges it needs and must not own schemas/tables or have bypass-RLS/superuser privileges.

### P1 — Trusted tenant context must be designed before RLS

Current repository APIs pass tenant IDs into SQL predicates, but the adapter does not yet establish a database-verifiable trusted principal for RLS. A caller-controlled custom session variable is not sufficient authentication.

**Required correction:** choose a trusted transaction-scoped context derived from ORIENT's authenticated server-side identity, or use validated signed claims. Ensure pooled connections cannot leak context between transactions; use transaction-local settings and test reset/reuse behavior.

### P1 — Keep the Data API closed by default

Supabase's breaking change published 2026-04-28 states that newly created public tables are no longer automatically exposed to Data and GraphQL APIs, enforced across projects on 2026-10-30. Keep ORIENT application tables unexposed unless an explicit API surface is reviewed and approved. This does not replace role restrictions or RLS.

### P1 — CLI v3 hosted-targeting behavior changed on 2026-11-04

Supabase CLI v3 runs database commands against the local stack by default; hosted changes require explicit remote targeting and confirmation. Future automation must be checked against the v3 migration guidance and must not assume a database command targets the hosted project.

## Safe next implementation sequence

1. Define the identity/tenant contract for both `tenant_id` and `owner_id`.
2. Split migration execution from runtime startup.
3. Create and test restricted runtime/migration roles.
4. Add entity-specific RLS policies and role grants.
5. Add tests for tenant isolation, owner isolation, pooled-connection context leakage, and migration idempotency.
6. Run the existing PostgreSQL integration suite against a disposable/local PostgreSQL 17 instance.
7. Apply the reviewed migration to this empty Supabase development project only after the above gates pass.
8. Re-run Supabase security/performance advisors and verify the resulting schema, grants, RLS flags, and policies.

## Change log

No Supabase schema, rows, migrations, credentials, extensions, or project settings were changed by this audit.
