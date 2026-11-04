# ORIENT Supabase Identity and RLS Readiness Audit

**Date:** 2026-11-05  
**Scope:** Read-only repository audit; no Supabase database or project changes

## Decision

Do not create tenant RLS policies or run the ORIENT schema migration yet. The current application identity model does not provide a verified mapping from an authenticated principal to the database's `tenant_id` and `owner_id` columns, and the PostgreSQL adapter does not yet propagate a trusted identity context through every query transaction.

A generic `auth.uid()` policy would be incorrect today because ORIENT's current owner login is not Supabase Auth.

## Evidence from the current repository

### 1. Owner authentication is a single local Admin identity

`src/core/security/owner-identity-service.js` implements a single `Admin` username, verifies a local password hash, and persists owner sessions in a local state file. Its session identifiers are random UUIDs, but the service does not issue or validate Supabase Auth JWTs and does not map the owner to a Supabase `auth.users.id`.

`app.js` composes this identity from the website data directory's `owner.json` and passes the resulting adapter to the website. The PostgreSQL persistence layer is not the source of this identity/session state.

### 2. Runtime tenant identity is a static process configuration

`src/core/config/index.js` sets:

- `defaultTenantId = process.env.ORIENT_TENANT_ID || 'local'`

`app.js` passes this configured value into `OrientRuntime`. The runtime defaults `userId` and `workspaceId` to `local` unless supplied in its constructor. This is a process-level tenant setting, not an authenticated per-request tenant principal.

### 3. The database has two distinct ownership shapes

The current PostgreSQL schema includes:
- Tenant-scoped tables with a `tenant_id` column, such as executions, events, idempotency, checkpoints, workflows, approvals, worker nodes, and quota data.
- Owner-scoped tables such as `owner_chat_messages` and `owner_work_profiles`, keyed by `owner_id`.

The schema does not define a foreign-key or canonical mapping between the local Admin session and either ownership identifier.

### 4. The PostgreSQL adapter does not yet provide transaction-scoped tenant context

`PostgresDatabase.query()` delegates directly to `pool.query()`. Its `transaction(work)` method obtains a client, but repository methods are not uniformly wrapped in a trusted context-establishing transaction. Therefore, adding a policy based on `current_setting('app.tenant_id')` now would either fail for many calls or tempt the implementation to use a caller-settable, untrusted value.

A custom PostgreSQL setting alone is not authentication. Never trust a tenant value supplied directly by a request, tool argument, user-editable metadata, or arbitrary SQL caller.

## Required identity architecture decision

Before implementing RLS, choose and test one authoritative design:

### Option A — Supabase Auth-backed principals

- Introduce an explicit ORIENT Auth adapter that validates Supabase JWT signatures and claims on the trusted server.
- Map the verified subject to ORIENT's canonical user, owner, tenant, and workspace records.
- Store authorization attributes in trusted server-controlled metadata or a canonical database membership table; never authorize from user-editable metadata.
- Use signed claims or a database lookup to derive the exact tenant and owner identity.
- Keep Supabase Auth replaceable; local-only ORIENT must continue to work without it.

### Option B — ORIENT-owned server sessions

- Extend the existing canonical OwnerIdentity lifecycle with a durable, explicit principal-to-tenant/owner mapping.
- Keep the session token secret server-side and validate it before any database operation.
- Define a trusted database identity propagation mechanism that cannot be set by untrusted callers.
- Ensure every repository operation runs within the transaction that establishes and clears that verified context.
- Document the threat boundary: RLS is defense in depth against query mistakes, not a substitute for isolation from a compromised server/database credential.

Do not mix the two models implicitly. Select one for the first cloud integration milestone and define how multiple users/tenants will be represented before building policies.

## Required implementation and tests

1. Add a canonical principal contract: `principalId`, `tenantId`, optional `ownerId`, `workspaceId`, auth source, and session identity. All identifiers must come from a trusted authentication adapter.
2. Define how the existing single Admin maps to a stable owner record without assuming that a local session UUID is a user ID.
3. Add a database unit-of-work/context API so repository operations cannot accidentally run outside the trusted transaction context.
4. Ensure transaction-local identity cannot leak across pooled connections or survive rollback/reuse.
5. Create separate migration-owner and restricted runtime roles; neither the runtime role nor public API roles may own tables or bypass RLS.
6. Define separate policies for each tenant-owned and owner-owned table, including SELECT policy requirements for UPDATE and `WITH CHECK` for writes.
7. Test cross-tenant and cross-owner read/write denial using the actual runtime role, not the administrative `postgres` role.
8. Verify local JSON/SQLite modes continue to operate with no Supabase account, JWT, or network dependency.

## Explicit safety boundary

- Do not run `npm run db:migrate` against Supabase yet.
- Do not create generic RLS policies using `auth.uid()` or an unsigned custom GUC.
- Do not grant the normal runtime role schema ownership, superuser, or `BYPASSRLS`.
- Do not expose ORIENT application tables through the Data API.
- No database schema, data, credentials, extensions, or project settings were changed during this audit.
