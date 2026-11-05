# ORIENT Canonical Owner Principal Contract

**Status:** Principal, repository binding, role topology, and version-9 RLS migration implemented on this branch; hosted project not migrated  
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

**Important limitation:** direct low-level database access remains available to infrastructure code. Application repositories are bound, but this is not a cryptographic boundary against arbitrary SQL executed with the runtime credential.

## 7. Trust boundary and remaining database work

The application-level principal contract, repository binding, separate database roles, and version-9 RLS policies are implemented in code. The hosted Supabase project has not been migrated. The GUC context remains a trusted-server transport mechanism, not cryptographic proof of identity.

Before enabling this on a hosted project:
1. Run `npm run db:roles` with `ORIENT_ADMIN_DATABASE_URL`, `ORIENT_MIGRATOR_PASSWORD`, and `ORIENT_RUNTIME_PASSWORD` supplied through a secure environment; this provisions `orient_owner`, `orient_migrator`, `orient_runtime`, and `orient_runtime_login` and transfers existing ORIENT table ownership.
2. Configure `ORIENT_MIGRATION_DATABASE_URL` to use `orient_migrator` and set `ORIENT_MIGRATION_ROLE=orient_owner`; then run `npm run db:migrate`.
3. Configure application `DATABASE_URL` with `orient_runtime_login`, never the admin or migration login.
4. Verify the runtime role is not a table owner, superuser, or `BYPASSRLS` role. The version-9 migration grants only required table CRUD, read-only access to migration metadata, and sequence usage.
5. Run the integration suite and advisors against the target project; review all grants, policies, and exposed schemas.
6. Keep database credentials server-side. Do not expose the runtime login to browser/mobile clients.
7. Local JSON/SQLite must continue working without Supabase.

Do not use `auth.uid()` for the local ORIENT owner session: it is not a Supabase Auth user. Policies use transaction-local `app.orient_tenant_id` and `app.orient_owner_id` values installed by the trusted server. PostgreSQL custom settings are user-settable: a caller with arbitrary SQL under `orient_runtime_login` can spoof them. This design protects against omitted tenant predicates and accidental cross-scope queries, but it does not defend against SQL injection/arbitrary SQL or a compromised application process. If that threat is in scope, add a database-verifiable signed-principal mechanism before claiming hostile-client isolation.

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

The repository-binding milestone is implemented for every repository exposed by `PostgresPersistence`; remaining work is independent security verification of the runtime connection credential, pool lifecycle, GUC threat boundary, hosted grants/advisors, and an explicitly approved development migration. No Supabase schema or project setting is changed by this contract.


## 9. Database role and RLS implementation

The explicit provisioning command is `npm run db:roles` (`scripts/provision-postgres-roles.js`). It requires an administrative connection and two independently generated passwords supplied through environment variables; it never prints passwords.

| Role | Login | Purpose |
|---|---:|---|
| `orient_owner` | No | Owns ORIENT application tables; can bypass ordinary RLS as table owner, but is not a login and has no BYPASSRLS attribute. |
| `orient_migrator` | Yes | Dedicated migration credential; NOINHERIT membership permits explicit SET ROLE to `orient_owner`. |
| `orient_runtime` | No | Restricted policy/grant group; NOSUPERUSER, NOBYPASSRLS, does not own tables. |
| `orient_runtime_login` | Yes | Application connection credential; inherits `orient_runtime`, not owner privileges. |

The version-9 migration enables RLS on all tenant-owned and owner-owned application tables. Migration role elevation uses `SET LOCAL ROLE` inside the migration transaction so a pooled connection cannot be returned with the owner role still active. Tenant policies compare `tenant_id` to the transaction-local tenant context; owner policies compare `owner_id` to the transaction-local owner context. `schema_migrations` is global infrastructure metadata and is SELECT-only for the runtime role. The workflow fencing sequence is granted only for sequence use.

The runtime role is not granted DDL, TRUNCATE, REFERENCES, TRIGGER, or migration-table write access. Table ownership is transferred to `orient_owner` by the administrative provisioning step before migrations execute as that role.

### Verification added

The PostgreSQL integration suite now provisions the role topology, applies migrations as `orient_owner`, and verifies:
- runtime role is not superuser, table owner, or BYPASSRLS;
- runtime login has no CREATEDB, CREATEROLE, or REPLICATION attributes;
- runtime login has no CREATE privilege on the `public` schema;
- runtime login has only SELECT/INSERT/UPDATE/DELETE on application tables, with no TRUNCATE, REFERENCES, or TRIGGER privilege;
- runtime login has sequence USAGE but not sequence UPDATE privilege;
- tenant-A SELECT cannot see tenant-B rows;
- UPDATE and DELETE against tenant-B rows affect zero rows;
- INSERT with a mismatched tenant is rejected by RLS;
- owner-scoped chat rows are invisible across owner IDs.

These tests use a real PostgreSQL 17 service in CI. They validate the policy/grant behavior under `SET ROLE orient_runtime`; they do not prove resistance to a malicious SQL caller able to change custom GUC values.
