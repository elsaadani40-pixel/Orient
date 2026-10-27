# Provider-aware side-effect and idempotency inventory

**Scope:** production composition rooted at `app.js` on 2026-10-27. This is an evidence inventory for safety gate [#189](https://github.com/elsaadani40-pixel/Orient/issues/189), not a claim of exactly-once execution.

## Production tool inventory

| Tool / boundary | Observable effect | Current idempotency contract | Retry / recovery posture | Evidence |
|---|---|---|---|---|
| `memory.search`, `memory.list`, `memory.history` | Read local memory/audit state | `read_only` / `idempotent` | Tool retry remains disabled by default; repeated reads are safe at the tool-effect level | `src/application/tools/memory.tools.js`, `src/core/tools/tool.interface.js` |
| `memory.add`, `memory.delete` | Mutate local memory and associated audit/persistence state | `local_mutation` / `unknown` | `retryable` defaults to false; no provider reconciliation function is declared. Do not blindly replay after an uncertain result | `src/application/tools/memory.tools.js`, `src/core/tools/tool.interface.js` |
| `workspace.read` and other non-shadowed workspace tools | Read workspace files | Inspect each tool's metadata before adding retry support | Read-only operations only; path and workspace policy gates still apply | `src/application/tools/workspace.tools.js` |
| `project.audit`, `project.propose_changes` | Read project files and produce analysis/proposals | `read_only` / `idempotent` | No mutation or external provider action is intended | `src/application/tools/project.tools.js` |
| `project.execute_change` | Mutates project files; may run verification commands only if caller policy explicitly allows them | `local_mutation` / `reconcilable`; reconciliation requires a durable receipt scoped by tenant + operation ID and bound to workspace + change-set hashes | A verified result is receipted. Matching file contents without a receipt, a corrupt receipt, or a mismatched identity returns a conflict. No blind replay is justified by file contents alone | `src/application/tools/project.tools.js`, `src/infrastructure/execution/project-operation-receipt-store.js`, `test/unit/application/tools/project-operation-receipt-recovery.test.js` |
| Legacy `project.execute_change` definition from `workspace.tools.js` | Local workspace mutation | `local_mutation` / `unknown` after PR #306; no reconciliation contract | Retry disabled by default. Production composition filters duplicate names in favor of `project.tools.js`; keep this legacy definition fail-closed for alternate compositions | `src/application/tools/workspace.tools.js`, `app.js` |
| `ChannelAdapter.receive` | Authenticated inbound message invokes Runtime and sanitizes a response; it does not itself deliver a message to an external provider | No outbound delivery adapter or provider idempotency contract is implemented here | Treat this as ingress only. Do not infer that WhatsApp/SMS/phone delivery is available or safely retryable | `src/interfaces/channels/channel-adapter.js` |
| Model provider (`OllamaProvider`) | Model inference request; network activity depends on configured endpoint | Not a business side-effect idempotency mechanism | Production routing sets `allowRemote: false`; do not treat model request retries as provider-side-effect guarantees | `app.js`, `src/infrastructure/model/ollama.provider.js` |
| Async workflow worker | Can execute scheduled steps and retry failures if enabled | Generic worker retry classifier is not proof of provider idempotency | **Not started or wired in production** while issue #189 remains open; production task handling stays synchronous | `src/core/workflow/async-workflow-worker-service.js`, `src/core/workflow/async-workflow-worker.js`, `app.js` |

## Explicitly not yet proven

- No production adapter inventory currently demonstrates provider-supported idempotency keys for messaging, phone/device actions, or arbitrary external APIs; those actions must not be advertised as implemented by this inventory.
- Local receipt storage proves that a verified project mutation has a durable receipt, but a crash between the filesystem mutation and receipt commit can leave an unknown outcome. Reconciliation deliberately returns a conflict in that case; it does not establish global exactly-once behavior.
- Memory mutations have no durable operation receipt/reconciliation contract in the tool adapter. They remain non-retryable by default and need a separate design before any asynchronous retry path is allowed.
- This inventory does not satisfy the timeout-after-provider-success, crash-before-local-commit, lease-loss, repeated-resume, tenant-collision, or production-shutdown integration acceptance tests in issue #189.
- Production async worker activation remains blocked until each acceptance criterion in issue #189 is implemented and verified by CI.

## Safe operating rule

When an adapter cannot authoritatively determine whether an externally observable action already happened, surface an explicit unknown/conflict outcome for controlled recovery. Never replay merely because the local process lacks a completion record.
