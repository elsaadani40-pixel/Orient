# ORIENT ONE Dashboard and Control Plane

## Status and scope

The dashboard is a local-first operations interface served by the existing HTTP server at \`/dashboard\`. It is not a separate runtime and does not execute tools directly. All execution, cancellation, resume, authorization, approval validation, and persistence remain owned by the canonical ORIENT Runtime and its services.

The dashboard currently provides:

- HTTP reachability and renderer status, reported separately.
- Task submission through \`POST /agent\`.
- Tenant-scoped execution history with summary-only fields.
- Read-only status and pending-approval queries.
- A durable per-execution Server-Sent Events (SSE) stream.
- A WebGL scene with at most six nodes derived from actual streamed events.
- Explicit human confirmation before a pending approval is sent to the canonical resume endpoint.
- Explicit confirmation before a durable cancellation request is submitted.
- A CSS visual fallback if WebGL is unavailable; the event timeline remains usable.

It does **not** yet provide a global live graph across all executions, an all-tenant administrative console, an OpenTelemetry exporter, a browser automation suite, or a blanket security certification. WebGPU is not required and is not implemented as the current renderer.

## Start locally

From the repository root:

\`\`\`bash
npm ci
npm test
node app.js
\`\`\`

Open \`http://127.0.0.1:8080/dashboard\`. The default server binding is loopback-only (\`127.0.0.1\`). The root path \`/\` remains the existing memory interface.

The dashboard uses same-origin HTTP requests and introduces no CDN, external analytics, or new frontend package dependency.

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| GET | \`/dashboard\` | Serve the local dashboard |
| GET | \`/command-scene.js\` | Serve the local WebGL renderer |
| POST | \`/agent\` | Submit a task to the canonical runtime |
| GET | \`/executions?limit=50&offset=0\` | Read a bounded page of execution summaries |
| GET | \`/executions/:id\` | Read tenant-scoped durable execution status |
| GET | \`/executions/:id/approvals\` | Read pending approvals for one execution |
| GET | \`/executions/:id/events\` | Stream that execution's durable events using SSE |
| POST | \`/executions/:id/cancel\` | Persist a cooperative cancellation request |
| POST | \`/executions/:id/resume\` | Resume a durable checkpoint through runtime policy |
| GET | \`/approvals/pending?limit=100\` | Read the tenant-scoped pending approval inbox |

Read APIs use \`Cache-Control: no-store\`. Execution-history pagination is bounded to at most 100 entries per page and offsets are capped. The SSE replay window is bounded to 200 stored events; if a reconnect cursor is no longer available, the server emits a reset notification and replays the latest 50 events.

## Event stream contract

The server verifies that the requested execution exists in the configured tenant before opening the stream. The stream:

- Sends \`text/event-stream\` and a retry hint.
- Uses event IDs so browser \`EventSource\` reconnections can send \`Last-Event-ID\`.
- Replays events after the supplied cursor when it remains in the bounded window.
- Emits heartbeat comments while idle and cleans up timers when the response closes.
- Sends only an allowlisted envelope: event ID/type, execution ID, goal ID, timestamp, sequence, and selected scalar fields (\`step\`, \`stepId\`, \`tool\`, \`status\`, \`errorCode\`).
- Does not stream raw task inputs, arbitrary event payloads, or execution results.

The dashboard renders event strings through \`textContent\`, limits its visible timeline to 50 rows, and limits the 3D graph to six recent event nodes. Unknown or unavailable status is not converted into a fabricated success state.

## Human controls

### Pending approval

The inbox shows the tool, capability, step, execution ID, and expiry. The user must confirm the operation in the browser before the dashboard submits \`{ approval: { approvalId } }\` to \`POST /executions/:id/resume\`. The runtime's durable approval service remains authoritative; the UI does not mint or broaden permissions. A stale, expired, used, or scope-mismatched approval must fail at the runtime boundary.

### Cancellation

The history view only offers a cancellation request for a non-terminal execution that has not already requested cancellation. The action is described as a cooperative durable request, **not** an immediate process kill. Runtime persistence and the execution loop determine when cancellation takes effect.

## Persistence and scale

- **PostgreSQL:** execution history uses tenant-scoped count/page queries; execution-event replay uses a bounded indexed query; approval inbox and execution-scoped approval queries use durable SQL filters.
- **SQLite:** history and event replay use bounded SQL queries with tenant checks over stored JSON fields; approval lookup and pending inbox read durable SQLite state.
- **JSON:** remains suitable for local-first use and development. Its repository reads the JSON backing file to filter records, so it must not be represented as a high-throughput multi-tenant database adapter.

A future scale stage should add indexed cursor pagination and retention policies to each adapter, plus load tests using realistic event volumes. Do not claim production-scale throughput based only on unit tests.

## Security boundary

The default host is \`127.0.0.1\`. The current HTTP interface does not provide a complete remote-user authentication/session layer. **Do not set \`HOST=0.0.0.0\` or expose these routes to a LAN, reverse proxy, or public network without first adding and testing an authentication boundary and transport protection.** Same-origin requests and CSP headers are not substitutes for authentication.

Approval and cancellation controls are consequential operations. Keep runtime policy checks in place, review the tool/capability details, and never infer that a successful HTTP response proves a downstream side effect has completed.

## Manual smoke checklist

1. Run \`npm test\` and \`npm run check:syntax\`.
2. Start the app and open \`/dashboard\`; verify the status distinguishes server reachability from renderer state.
3. Submit a benign task and verify the actual server response is shown.
4. Open the security view and load execution history; verify summary fields do not include raw inputs/results.
5. Select a real execution ID; verify status and approval reads use the real APIs.
6. Start the event stream and confirm that only persisted events for that execution appear.
7. Reconnect the stream and confirm replay resumes after the last event ID; verify that a missing cursor produces a reset notification.
8. On a test execution only, request cancellation and verify the returned cancellation state.
9. On a deliberately created pending approval in a safe test environment, verify that canceling the browser confirmation sends no request; confirming sends the approval ID through the runtime resume route.
10. Disable WebGL in browser settings or use a browser without WebGL; verify the CSS fallback and event timeline remain available.
11. Test a narrow mobile viewport and \`prefers-reduced-motion: reduce\`.
12. Never use a real high-risk tool or production data as the first manual smoke test.

## Evidence

Automated integration and runtime tests cover the HTTP routes, tenant scoping, pagination, approval filtering, event replay, event-field redaction, and the dashboard-to-renderer bindings. CI does not currently execute a real browser/WebGL rendering test, so visual correctness on a particular device still requires the manual smoke checklist above.
