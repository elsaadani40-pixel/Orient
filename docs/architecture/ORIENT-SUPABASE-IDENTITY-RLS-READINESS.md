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

## 4. Trust boundary and remaining database work

This change establishes an application-level identity contract only. It does not yet enforce PostgreSQL RLS.

Before RLS can be enabled:
1. Every PostgreSQL repository operation must execute inside a mandatory transaction/unit-of-work that receives this verified principal.
2. Tenant and owner context must be transaction-local and cannot be accepted from untrusted callers.
3. All tables must have an explicit ownership mapping: tenant-owned, owner-owned, or intentionally global.
4. Runtime database credentials must not own tables and must not have `BYPASSRLS`.
5. Per-table policies and grants must be tested with the actual restricted runtime role.
6. Pool reuse tests must prove that identity context is reset after success, rollback, and exceptions.
7. Local JSON/SQLite must continue working without Supabase.

Do not use `auth.uid()` for the local ORIENT owner session: it is not a Supabase Auth user. Do not use unsigned `SET app.tenant_id` as proof of identity. A PostgreSQL custom setting is context transport, not authentication.

## 5. Verification

Unit coverage now verifies:
- stable UUID persistence across owner-service restart;
- principal construction only after a valid owner session;
- trusted tenant/workspace configuration validation;
- principal immutability;
- rejection of a random non-owner session token.

The next implementation milestone is a mandatory PostgreSQL unit-of-work boundary and repository migration to that boundary. No Supabase schema or project setting is changed by this contract.
