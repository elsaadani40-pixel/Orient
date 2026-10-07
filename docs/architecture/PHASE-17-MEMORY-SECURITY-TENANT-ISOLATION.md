# Phase 17 — Memory Security & Tenant Isolation

## Objective

Make memory security a real execution boundary rather than a passive policy object.

Phase 17 enforces two independent identities before repository access:

1. **Agent boundary** — the executing agent must be authorized for the requested memory scope and operation.
2. **Tenant boundary** — the tenant comes from canonical execution context and is never accepted from memory tool payloads.

## Security invariants

- Every memory operation requires a tenant identity.
- A runtime tenant mismatch is rejected.
- Memory tool input cannot override the canonical tenant.
- Memory scopes are persisted with each memory.
- Reads are filtered by both tenant and authorized scope.
- Writes persist the authorized tenant and scope, not caller-supplied identity.
- Deletes require both tenant and authorized scope.
- Cross-tenant records are indistinguishable from missing records at the service boundary.
- `delete` is a distinct memory policy operation.
- AgentLoop injects `memoryScope` from the normalized execution step, allowing policy enforcement to decide whether that scope is legal.
- Existing tool authorization and capability governance remain mandatory upstream.

## Trust flow

`user request → canonical runtime → plan/step → agent boundary → capability/tool governance → authorization → memory scope policy → tenant-scoped repository`

## Scope model

Supported memory scopes are:

- `personal`
- `shared.memory`
- `shared.research`

The default is `personal`.

Scopes are persisted on memory records so that authorization is enforceable on reads and deletes, not only at creation time.

## Legacy data

Existing memory records without `tenantId` or `scope` are migrated conservatively to:

- tenant: `local`
- scope: `personal`

This preserves existing local data while establishing explicit security metadata.

## Resume/checkpoint behavior

Execution checkpoints already persist tenant identity in the execution snapshot. Phase 17 does not create a second tenant source. Memory access continues to consume the tenant from the execution context supplied by the canonical runtime.

A future durable resume path must continue to restore and validate that identity before executing memory steps.

## Explicit non-goals

Phase 17 does not introduce:

- dynamic agents
- self-modification
- remote execution
- paid providers
- arbitrary code execution
- a UI-only memory filter

The repository boundary itself performs tenant and scope filtering.