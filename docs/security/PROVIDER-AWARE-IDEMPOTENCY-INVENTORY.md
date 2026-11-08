# Provider-aware side-effect and idempotency inventory

**Scope:** production composition rooted at `app.js`, rechecked against `main` at `eb4b98373c3b19f9573d58154f2ebb230b90ec0b` on 2026-11-07. This is an evidence inventory for safety gate [#189](https://github.com/elsaadani40-pixel/Orient/issues/189), not a claim of exactly-once execution.

## Production tool inventory

| Tool / boundary | Observable effect | Current idempotency contract | Retry / recovery posture | Evidence |
|---|---|---|---|---|
| `memory.search`, `memory.list`, `memory.history` | Read local memory/audit state | `read_only` / `idempotent` | Read-only operations; retry does not mutate memory | `src/application/tools/memory.tools.js`, `src/core/tools/tool.interface.js` |
| `memory.add`, `memory.delete` | Mutate local memory and its audit/persistence state | `local_mutation` / metadata remains `unknown`; both tools expose a reconciliation function backed by a durable tenant/scope/operation-ID audit receipt | `retryable` remains false. After an uncertain outcome, reconcile first. `memory.add` verifies the committed memory record matches requested text/type; `memory.delete` verifies an archive receipt for the exact target. Missing, mismatched, or unavailable evidence returns `unknown`, never success. This is local transactional reconciliation, not a provider-supported idempotency key | `src/application/tools/memory.tools.js`, `src/application/memory/memory.service.js`, `src/infrastructure/memory/memory-transaction-coordinator.js`, `test/unit/application/memory/memory-operation-reconciliation.test.js` |
| `workspace.read`, `workspace.list`, `workspace.search` | Read workspace files | `read_only` / `idempotent` | Repeated reads are safe at the tool-effect level; path and workspace policy gates still apply | `src/application/tools/workspace.tools.js`, `src/core/tools/tool.interface.js` |
| `project.audit`, `project.propose_changes` | Read project files and produce analysis/proposals | `read_only` / `idempotent` in the production `project.tools.js` definitions | No mutation or external provider action is intended | `src/application/tools/project.tools.js`, `app.js` |
| `project.execute_change` (production registration) | Mutates project files; command verification is disabled by production policy (`allowCommands: false`) | `local_mutation` / `reconcilable`; reconciliation requires a durable receipt scoped by tenant + operation ID and bound to workspace + change-set hashes | A verified result is receipted. Matching file contents without a receipt, a corrupt receipt, or a mismatched identity returns a conflict. A crash between filesystem mutation and receipt commit remains an unknown outcome and blocks replay | `src/application/tools/project.tools.js`, `src/infrastructure/execution/project-operation-receipt-store.js`, `test/unit/application/tools/project-operation-receipt-recovery.test.js` |
| Shadowed legacy `project.execute_change` definition in `workspace.tools.js` | Local workspace mutation | `local_mutation` / `unknown`; no reconciliation contract | Not exposed by the production registry: `app.js` removes workspace tools whose names are supplied by `project.tools.js`. Keep this legacy definition fail-closed for alternate compositions | `src/application/tools/workspace.tools.js`, `src/application/tools/project.tools.js`, `app.js` |
| `ChannelAdapter.receive` | Authenticated inbound message invokes Runtime and sanitizes a response; it does not itself deliver a message to an external provider | No outbound delivery adapter or provider idempotency contract is implemented here | Treat this as ingress only. Do not infer that WhatsApp/SMS/phone delivery is available or safely retryable | `src/interfaces/channels/channel-adapter.js` |
| Model provider (`OllamaProvider`) | Model inference request; network activity depends on configured endpoint | Not a business side-effect idempotency mechanism | Production routing sets `allowRemote: false`; do not treat model request retries as provider-side-effect guarantees | `app.js`, `src/infrastructure/model/ollama.provider.js` |
| Async workflow worker | Can execute scheduled steps and retry failures if enabled | Generic worker retry classifier is not proof of provider idempotency | **Not started or wired in production** while issue #189 remains open; production task handling stays synchronous | `src/core/workflow/async-workflow-worker-service.js`, `src/core/workflow/async-workflow-worker.js`, `app.js` |

## Memory backend selection boundary

- JSON is the default memory backend. When `persistenceMode === 'sqlite'` and the SQLite adapter exposes memory, audit, and transaction-coordinator repositories, `app.js` selects those repositories for `MemoryService`.
- When `persistenceMode === 'postgres'`, the current `app.js` composition does **not** select a PostgreSQL memory repository; it falls back to the JSON memory repository and JSON audit file. The PostgreSQL adapter's existence does not mean memory data is stored in PostgreSQL.
- PR #312 contains a proposed async MemoryService + PostgreSQL/SQLite unification, but it is stale, overlaps PR #319/#188, and has not been merged. Treat PostgreSQL memory persistence as not implemented in current production composition until a decomposed, exact-head-validated slice lands.

## Evidence currently present

- Memory reconciliation tests cover committed `memory.add` and `memory.delete` receipts, process exit after the mutation/audit transaction commits but before execution completion is recorded, repeated deletion reconciliation, target/payload mismatch, missing receipt, missing transaction coordinator, and tenant-scoped receipt lookup.
- The memory transaction coordinator provides the consistency boundary for the memory record and audit receipt. Reconciliation acquires a consistent read snapshot and fails closed if a transaction is in progress.
- Project mutation tests cover receipt-backed recovery, pending-intent replay prevention, receipt-write failure after workspace mutation, corrupt/mismatched receipts, and cross-tenant receipt isolation.
- The production registry is startup-only and sealed. It registers memory tools, non-shadowed workspace tools, and the governed project tools; it does not register process execution, arbitrary network/API, outbound messaging, phone, or device adapters.
- Production shutdown is wired in `app.js` through `src/core/runtime/shutdown-in-order.js` with ordered stages HTTP ingress → observations → worker-stop placeholder → Runtime → persistence. The worker stage is intentionally a no-op because no production worker is wired. A production-composition integration proof for an actual worker drain remains outstanding.

## Explicitly not yet proven

- No production adapter demonstrates provider-supported idempotency keys or authoritative provider-state reconciliation for messaging, phone/device actions, or arbitrary external APIs; those capabilities are not currently registered and must not be advertised as implemented.
- Local memory audit receipts and project operation receipts are local durability/reconciliation mechanisms. They do not establish provider-level or global exactly-once behavior.
- A crash between a project filesystem mutation and durable receipt commit remains an unknown outcome; reconciliation deliberately refuses to infer success from matching file contents alone.
- The complete async task HTTP lifecycle is not yet proven end-to-end: acceptance/idempotency replay, status/events/cancellation, worker restart through approval wait and owner resume, lease-loss races, tenant isolation at the public task boundary, and production worker drain integration remain gates.
- Production async worker activation remains blocked until every acceptance criterion in issue #189 is implemented and verified by CI.

## Safe operating rule

When an adapter cannot authoritatively determine whether an externally observable action already happened, surface an explicit unknown/conflict outcome for controlled recovery. Never replay merely because the local process lacks a completion record.


## Revalidation boundary (2026-11-07)

- This inventory describes the implementation on the stated `main` SHA only. Draft changes in PR #327 that harden the project-operation receipt lock are not part of this baseline and must not be assumed deployed.
- The production registry and shutdown order were rechecked in `app.js`; the shutdown helper is `src/core/runtime/shutdown-in-order.js`. No production async worker registration was found in `app.js`.
- The inventory is an evidence map, not a guarantee of exactly-once execution. Where an effect lacks authoritative reconciliation, its outcome remains unknown and automatic retry stays disabled.
