# ORIENT Unified Task API — v1 Contract

**Status:** proposed contract; not implemented merely by this document. Runtime handlers and clients must be wired and tested before any endpoint is advertised as available.

## Goals

- One canonical task model across Android, tablet, desktop, and web.
- Keep planning, authorization, approval, execution, persistence, recovery, and verification inside the canonical ORIENT runtime.
- Clients are untrusted presentation/adapters; never duplicate policy decisions in a client.
- Explicitly report unsupported capabilities and offline state; never fabricate task results.

## Identity, scope, and versioning

- Prefix: `/api/v1`.
- Every request is authenticated by the existing server-side session mechanism. Do not accept a client-supplied owner/tenant as authoritative.
- Resolve workspace/user scope from the authenticated principal, then enforce it on every read and mutation.
- Use request IDs for correlation; use idempotency keys for task creation and retryable mutations.
- Return a stable API version and capability version in health/capability responses.
- Do not expose secrets, tokens, private memory, or unrestricted audit data in task/event responses.

## Canonical resources

### Capability discovery

`GET /api/v1/capabilities`

Returns only capabilities actually registered and enabled in this runtime instance. Each entry declares: `id`, `version`, `description`, `inputSchema`, `outputSchema`, supported platforms, permission requirements, risk class, network requirements, timeout/resource limits, verification strategy, and whether human approval is required. Do not list roadmap-only features as executable.

### Create and inspect tasks

`POST /api/v1/tasks`

Request: `{ "goal": "...", "idempotencyKey": "..." }`; clients should send the key in the `Idempotency-Key` header. The server also accepts the body field for compatibility.

Response: `{ "apiVersion": "v1", "task": { "id": "...", "status": "...", "createdAt": "...", "version": 1 }, "replayed": false }`

The implemented slice validates the owner session/origin, bounds the request body and goal, routes through the existing AgentService and canonical Runtime, and uses the durable idempotency repository. Repeating the same key and same normalized goal replays the stored task summary; reusing a key for a different goal returns `409 IDEMPOTENCY_KEY_REUSED`; an in-progress or previously failed key returns a conflict rather than rerunning side effects. Responses use `201` for the first request and `200` for a completed replay.

**Important implementation limit:** this endpoint currently awaits the canonical runtime execution synchronously and returns the observed task state. It is not yet a queue-acceptance API, and it does not claim asynchronous dispatch. It fails closed when the configured persistence adapter does not provide durable idempotency storage. Async task acceptance, rate limiting, and a PostgreSQL idempotency repository remain follow-up work.

`GET /api/v1/tasks` lists only the caller's authorized tasks, with cursor pagination and bounded page size.

`GET /api/v1/tasks/{taskId}` returns scoped task state, current step, timestamps, progress, blockers, approval state, and latest verification summary.

`POST /api/v1/tasks/{taskId}/cancel` requests cooperative cancellation. Response must distinguish requested from confirmed cancellation.

### Plans and approvals

`GET /api/v1/tasks/{taskId}/plan` returns the versioned plan, dependencies, acceptance criteria, risk classification, prerequisites, and recovery/rollback steps.

`POST /api/v1/tasks/{taskId}/approvals/{approvalId}` records an authenticated approve/reject decision against the exact immutable action digest. Approval must be scoped, expiring, single-use where applicable, and checked again at execution time. A stale or changed action requires fresh approval.

### Event trace

`GET /api/v1/tasks/{taskId}/events?after=<cursor>` returns ordered, cursor-paginated, privacy-filtered events. Event records include event ID, task ID, sequence, timestamp, type, step ID, outcome, and safe metadata. Never return raw secrets or unrestricted tool output. Detect and report gaps instead of silently presenting an incomplete trace.

Current implementation slice: the server exposes this route behind the existing owner-session gate, and the Android companion has an authenticated cursor-client method. It currently pages within the newest 200 events available from the runtime; a cursor outside that retained window returns `409 EVENT_CURSOR_NOT_FOUND` rather than silently skipping history. This is not yet durable unbounded event archival or end-to-end device synchronization.

### Governed file operations (read-only first)

`POST /api/v1/workspace/search` and `POST /api/v1/workspace/read` are available only after corresponding capabilities are registered. Requests must be confined to an authorized workspace root, enforce byte/line/result limits, reject path traversal and symlink escapes, and return truncation metadata. Treat file content as untrusted data, not policy.

Write/edit endpoints are intentionally **not** specified as generally available in v1. Before enabling writes, implement diff preview, exact target confirmation, path confinement, authorization, risk/approval gates, durable checkpoint/backup, atomic replacement where possible, post-write verification, and rollback tests.

## Optional device permissions

Android and other device permissions are optional, feature-scoped user choices; they are never a blanket prerequisite for using ORIENT. Clients request a permission only when the user invokes a feature that needs it, explain the purpose, and preserve unrelated functionality after denial. A missing/revoked permission must produce an explicit blocked or needs_user_input state and may offer a safe alternative; it must never produce a fabricated success. OS permission grants do not replace runtime capability authorization, risk checks, or human approval. See docs/security/OPTIONAL-DEVICE-PERMISSIONS.md for the required policy and acceptance tests.

## Task lifecycle

`accepted → scoped → discovering_capabilities → researching → planned → preflight → awaiting_approval → executing → verifying → completed`

Other terminal/intermediate states include `blocked`, `failed`, `cancel_requested`, `cancelled`, `recovering`, and `needs_user_input`. Transitions must be validated server-side. A task may reach `completed` only after explicit acceptance checks pass and verification evidence is persisted. A failed step must not be silently marked successful.

## Reliability and offline behavior

- Persist task state and event sequence before acknowledging durable transitions.
- Use bounded retries, idempotent handlers, deadlines, cancellation, and resumable checkpoints.
- Use optimistic versioning/ETags for conflicting mutations.
- Clients may queue safe drafts offline, but must clearly label them local/unsubmitted. Never imply server execution while offline.
- Sync must detect conflicts and require deterministic merge or user resolution; last-write-wins is not an acceptable silent default for task plans or approvals.
- Return typed errors: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND` (without cross-tenant disclosure), `VALIDATION_ERROR`, `CAPABILITY_UNAVAILABLE`, `APPROVAL_REQUIRED`, `CONFLICT`, `RATE_LIMITED`, `OFFLINE`, and `INTERNAL_ERROR`.

## Security requirements

- Deny by default; capability execution goes through the existing authorization and policy path.
- Enforce user/workspace isolation on every query, event stream, file operation, and approval.
- Validate input schemas and bound payloads, pagination, output size, concurrency, and runtime.
- Use CSRF protection where cookie sessions are used; rate-limit authentication and task creation.
- Audit security-relevant decisions with minimum necessary metadata and retention controls.
- Do not permit clients to set risk class, bypass approval, choose an arbitrary filesystem root, or invoke unregistered tools.

## Required acceptance tests

1. Authenticated task create/read/list is scoped to the caller; cross-user reads and events are denied.
2. Repeated idempotency key does not create duplicate tasks.
3. Unknown/unregistered capability fails closed.
4. High-risk action cannot execute before approval; altered action digest invalidates approval.
5. Task cannot complete if acceptance checks fail or verification evidence is absent.
6. Event pagination preserves sequence and detects gaps.
7. Cancellation, timeout, process restart, and retry preserve correct state without duplicate side effects.
8. Offline client distinguishes local drafts from server-accepted tasks.
9. Path traversal, symlink escape, oversized reads, and untrusted file instructions are handled safely.
10. Contract tests exercise the actual runtime handlers, not mocked duplicate business logic.

## Implementation sequence

1. Inventory existing HTTP routes, task stores, session/authorization middleware, runtime entry points, and Android calls.
2. Map existing routes to this contract; record gaps in the feature matrix.
3. Implement the smallest server-side task/capability read API by reusing existing services.
4. Add contract, scope-isolation, and failure-path tests.
5. Connect responsive web and Android clients to the same API.
6. Add read-only workspace capabilities, then separately design and review governed writes.
7. Add end-to-end research → plan → preflight → execute → verify → validated-learning tests.
8. Verify Android build/emulator and desktop/tablet/mobile viewports; record physical-device evidence separately.

No implementation or release claim is valid until the corresponding code, tests, and CI evidence exist.
