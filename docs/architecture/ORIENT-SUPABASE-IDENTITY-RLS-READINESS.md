# ORIENT Canonical Owner Principal Contract

**Status:** Implemented foundation; database enforcement not yet enabled  
**Branch:** `feat/supabase-optional-cloud-architecture`  
**Scope:** Local owner authentication and server-side principal derivation

## 1. Canonical principal

A successfully authenticated ORIENT owner session now resolves to this immutable server-side principal:

```ts
type OrientPrincipal = Readonly<{
  principalId: string;       // equal to ownerId for the current single-owner model
  ownerId: string;           // stable UUID persisted in owner.json
  tenantId: string;          // trusted process configuration, currently one tenant per Runtime
  workspaceId: string;       // trusted server configuration; defaults to "local"
  authSource: 'orient-owner-session';
  sessionId: string;         // authenticated session identifier, never the bearer token
}>;
```

The principal is created only after `OwnerIdentityService.authenticate(token)` successfully validates the opaque owner session. Public-user cookies and arbitrary request fields do not create this principal.

## 2. Stable owner identity lifecycle

- New owner state receives a cryptographically random UUID `ownerId`.
- Existing canonical `owner.json` files without an `ownerId` are upgraded once and persist the generated UUID.
- Legacy website owner-state migration also assigns an `ownerId` while preserving the existing password verifier and existing forced-rotation behavior.
- Invalid supplied owner IDs fail closed.
- The owner ID is not returned from the unauthenticated owner status endpoint.
- Session tokens remain opaque secrets; only their independent session IDs enter the principal.

## 3. Tenant and workspace provenance

For this milestone, `tenantId` comes from the trusted server configuration `ORIENT_TENANT_ID` (default `local`) and is injected into `OwnerIdentityRuntimeAdapter` during application composition. It is not read from request JSON, query parameters, cookies, tool arguments, or user metadata.

The current deployment model is still one configured tenant per Runtime process. This is **not yet** a multi-tenant user membership system. A future multi-tenant deployment must derive tenant membership from a canonical authenticated membership record and must not let the caller choose an arbitrary tenant.

`workspaceId` is currently server-configured and defaults to `local`; workspace membership/authorization remains a separate future gate.


## 4. Runtime composition and repository binding

The runtime composition now creates a distinct internal owner principal using `authSource: 'orient-runtime-owner'`. It is anchored to the stable owner UUID persisted in the existing owner identity state and scoped to the configured tenant/workspace. It is deliberately distinct from a browser login session: background execution and internal persistence work must not pretend that a human login session is active.

In PostgreSQL mode, application composition:
1. Copies the stable owner UUID into both owner-scoped repositories (`owner_chat_messages`, `owner_work_profiles`), replacing the former placeholder `owner` value.
2. Binds every exposed PostgreSQL repository (`executions`, `events`, `idempotency`, `checkpoints`, `workers`, `workflows`, `workflowLeases`, `approvals`, `tenantQuotas`, `ownerChat`, `ownerProfile`) to the immutable internal runtime principal.
3. Wraps each repository method in `withPrincipal()`, so repository methods that call other methods remain inside the same transaction context through AsyncLocalStorage.

The persistence adapter refuses rebinding to a different owner/tenant/workspace principal. JSON and SQLite adapters are not changed by this PostgreSQL-specific composition.

## 5. Database ownership inventory

The current PostgreSQL schema has the following intended ownership classes:

| Ownership class | Tables | Enforcement key |
|---|---|---|
| Tenant-owned | `executions`, `events`, `idempotency`, `checkpoints`, `execution_resume_leases`, `workflows`, `workflow_leases`, `workflow_dispatch_claims`, `approvals`, `worker_nodes`, `tenant_quota_limits`, `tenant_quota_reservations` | `tenant_id = current_setting('app.orient_tenant_id', true)` |
| Owner-owned | `owner_chat_messages`, `owner_work_profiles` | `owner_id = current_setting('app.orient_owner_id', true)` |
| Global infrastructure metadata | `schema_migrations`, `workflow_lease_fencing_seq` | Migration-only; never exposed to Runtime application roles |

No application table is classified as globally readable. The sequence is an infrastructure object, not application data.

**Important trust limitation:** PostgreSQL custom GUC values are transaction-local context transport, not cryptographic authentication. They are only meaningful if the database connection is private to the trusted ORIENT server and arbitrary SQL execution is not exposed to callers. The future restricted runtime role must not be usable by browser/mobile clients or the Supabase Data API. If the threat model requires database-level protection against a compromised application process or arbitrary SQL under the runtime role, replace this GUC trust model with a stronger signed/verified principal mechanism before enabling RLS.

## 6. PostgreSQL principal-scoped unit of work

The database context boundary is now integrated into the PostgreSQL runtime composition. It is implemented in `PostgresDatabase.withPrincipal(principal, work)` and exposed through `PostgresPersistence.withPrincipal()`.

- It validates the owner-principal contract before acquiring a connection.
- It opens one transaction and installs principal, owner, tenant, workspace, and session identifiers with parameterized `set_config(..., true)` calls, making the values transaction-local.
- `AsyncLocalStorage` routes repository calls through the active transaction client without requiring every repository to pass the client explicitly.
- Nested transactions use savepoints on the same client.
- A nested attempt to switch principal, tenant, workspace, or session is rejected.
- Unit tests cover context pinning, nested transactions, principal-switch rejection, rollback, and re-establishment on pooled connection reuse.

**Important limitation:** existing repositories have not all been migrated to require `withPrincipal()`; unscoped calls still use `pool.query()`. Therefore this is groundwork, not an RLS-ready enforcement boundary. Do not enable policies yet.

## 7. Trust boundary and remaining database work

The application-level principal contract and initial database context transport are implemented. PostgreSQL RLS is **not** enabled and is not yet safe to enable.

Before RLS can be enabled:
1. Remove or explicitly classify any future unscoped repository/database access; the app-level repositories are now bound, but direct low-level DB access remains possible to infrastructure code.
2. Tenant and owner context must remain transaction-local and cannot be accepted from untrusted callers.
3. All tables must have an explicit ownership mapping: tenant-owned, owner-owned, or intentionally global.
4. Runtime database credentials must not own tables and must not have `BYPASSRLS`.
5. Per-table policies and grants must be tested with the actual restricted runtime role.
6. Pool reuse tests must prove that identity context is reset after success, rollback, and exceptions.
7. Local JSON/SQLite must continue working without Supabase.

Do not use `auth.uid()` for the local ORIENT owner session: it is not a Supabase Auth user. Do not use unsigned `SET app.tenant_id` as proof of identity. A PostgreSQL custom setting is context transport, not authentication.

## 8. Verification

Unit coverage now verifies:
- stable UUID persistence across owner-service restart;
- principal construction only after a valid owner session;
- trusted tenant/workspace configuration validation;
- principal immutability and no disclosure from the public status response;
- rejection of a random non-owner session token;
- scoped queries pinned to one transaction client;
- all PostgresPersistence repositories bound to the internal runtime principal;
- owner chat/profile repositories mapped to the stable owner UUID;
- nested savepoints and rejection of principal switching;
- transaction-local context re-established across pooled connection leases.

The next implementation milestone is migrating every PostgreSQL repository path behind the scoped unit of work and classifying system/background work explicitly. No Supabase schema or project setting is changed by this contract.
