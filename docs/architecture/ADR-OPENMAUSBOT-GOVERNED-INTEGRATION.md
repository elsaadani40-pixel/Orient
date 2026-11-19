# ADR: Governed OpenMausBot integration

- **Status:** Proposed; Phase 1 read-only adapter implementation is under review
- **Date:** 2026-11-09
- **Related issue:** [#371](https://github.com/elsaadani40-pixel/Orient/issues/371)
- **Upstream:** [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)
- **MCP contract:** [OpenMausBot MCP server](https://github.com/milind-soni/OpenMausBot/blob/main/docs/mcp-server.md)

## Context

ORIENT needs a way to coordinate multiple specialized agents without creating a second execution authority or duplicating a large desktop application. OpenMausBot provides a local-first desktop roster of agents, per-agent model selection, task conversations, and an MCP server for inspecting and coordinating that roster.

The upstream project is a standalone Electron/React application, not a reusable agent SDK. Its current package manifest declares Node.js `>=24`, while ORIENT targets Node.js `>=22`. Its MCP server is exposed as a separate stdio process (`openmausbot mcp`) and talks to the running desktop harness. Its v1 tools include read-only discovery and transcript tools as well as task dispatch, interruption, bot/channel configuration, and model switching.

ORIENT already has the required authority boundaries: canonical Runtime, ToolRegistry, capability mapping/policy, AuthorizationService, durable approvals, tenant-scoped persistence, and execution/audit records. Any integration must use those boundaries rather than introducing a parallel task state machine.

## Decision

Integrate OpenMausBot as an **optional external agent-fleet provider over MCP**. Do not vendor, fork, embed, or make it a required runtime dependency.

- ORIENT remains authoritative for owner identity, tenant scope, canonical task identity, plans, capability decisions, durable approvals, execution state, audit evidence, cancellation, and recovery.
- OpenMausBot remains a separately installed and operated agent desktop/harness.
- ORIENT communicates with the upstream MCP server through a narrow adapter and an explicit operator-configured process/endpoint.
- The connector is disabled by default. Missing, stopped, or incompatible OpenMausBot must not prevent ORIENT from starting or running its native agents.
- All external data (agent names, profiles, transcripts, tool output, and job status) is untrusted input. It cannot modify ORIENT policy, grant capabilities, or authorize an action.

## Responsibility boundary

| Concern | Authority |
|---|---|
| Owner authentication and tenant identity | ORIENT |
| Canonical plan, execution ID, task lifecycle, retries and recovery | ORIENT |
| Capability mapping, risk classification and ORIENT approvals | ORIENT |
| Agent process, model selection, conversation UI and agent-specific runtime | OpenMausBot |
| Approval of tools invoked inside an OpenMausBot agent | OpenMausBot's native approval UI, retained as an additional gate |
| Final acceptance and evidence that the user's goal was met | ORIENT, based on verified evidence |

An ORIENT approval to dispatch a message is not an approval for every subsequent action performed by the remote agent. OpenMausBot's own ask-before-act controls must remain enabled. Until an independently tested policy bridge exists, delegated agents must not be granted host-computer control, arbitrary shell, filesystem mutation, VM lifecycle, or external connected-app actions. The first release should be restricted to safe research/reasoning tasks and read-only discovery.

## Rollout

### Phase 0 — contract and threat model

This ADR and issue #371 establish the protocol boundary, security assumptions, licensing constraints, and acceptance gates. No runtime dependency or upstream source is added in this phase.

### Phase 1 — read-only discovery

The review branch implements an optional, disabled-by-default adapter with a native Node.js stdio MCP client, a minimal child-process environment, a strict allowlist, bounded frames/responses/timeouts, endpoint identity verification, and four governed ToolRegistry tools. It introduces no runtime package dependency and does not change ORIENT's Node.js floor. This implementation is not considered shipped until its exact-head CI and security tests pass and the PR is reviewed.

Expose only these upstream MCP tools through ORIENT's governed adapter:

- `get_system_health`
- `list_bots`
- `list_channels`
- `list_available_models`

Do not expose transcript reads by default. If later required, add bounded pagination, owner-scoped authorization, explicit data minimization, and redaction.

The adapter must verify the expected OpenMausBot health identity before use. Unknown upstream tools and unknown response shapes are rejected.

### Phase 2 — owner-approved delegation

Only after Phase 1 passes its exact-SHA CI and security gates, consider:

- `send_bot_message` and `send_channel_message`
- `wait_for_conversation`
- `interrupt_conversation`

Dispatch is an external side effect. It requires a durable ORIENT approval bound to the tenant, owner, external bot/channel, exact task content hash, execution ID, plan revision, and idempotency key. Use upstream `send_id` to prevent duplicate sends. Persist the external receipt before reporting dispatch success.

A transport status of `settled` is not a successful task verdict. ORIENT must inspect the upstream job state, distinguish completed/failed/needs-input/stalled/timed-out, and preserve the distinction in its own durable execution record. A retry must reconcile the prior external send rather than send again.

### Phase 3 — deeper tool-policy bridge (not approved by this ADR)

Computer control, shell, file edits, connected apps, VM lifecycle, credential management, and automatic approval are excluded. They require a separately reviewed protocol that makes ORIENT authorization enforceable at the actual action boundary, not merely at message dispatch.

## Security and operational requirements

1. Spawn only an operator-configured executable and fixed argument vector with `shell: false`. No model-controlled command, args, URL, environment, or binary path.
2. Bound JSON-RPC frame size, response size, pending requests, concurrency, one total operation deadline, and process lifetime. Handle malformed frames, protocol errors, process exit, backpressure, and graceful termination. Explicit cancellation is deferred because Phase 1 exposes only short, read-only discovery calls.
3. Validate configured origins. Permit loopback HTTP; permit remote endpoints only over HTTPS or explicitly allowed private-network transport. Reject public plain HTTP, URL credentials, redirects to untrusted origins, and ambiguous host forms.
4. Store pairing/bearer tokens only in operator-managed secret configuration. Never put them in source, logs, plans, model context, transcripts, or audit payloads. Support token rotation and revocation; fail closed when a configured credential is missing or rejected.
5. Use a strict tool allowlist and validate each request and response against locally defined schemas. Upstream tool descriptions and annotations are informational, not authorization.
6. Enforce ORIENT tenant/owner scope before every call. Do not allow cross-tenant bot discovery, task dispatch, transcript access, or job polling.
7. Treat all remote agent content as prompt-injection-capable untrusted data. It cannot request policy changes, expose secrets, or trigger tools without a new ORIENT authorization decision.
8. Persist correlation IDs, provider instance, external bot/task IDs, approval reference, timestamps, status, and result hashes. Raw transcripts require a separate retention and data-scope decision.
9. Never forward ORIENT owner credentials, database credentials, or provider API keys to OpenMausBot. The connector must not read or export OpenMausBot provider credentials.
10. The connector is optional and must not change the ORIENT Node.js support floor or add mandatory cloud services.

## Compatibility and licensing

- ORIENT targets Node.js `>=22`; the current OpenMausBot package declares Node.js `>=24`. A process boundary avoids raising ORIENT's runtime requirement.
- OpenMausBot's repository root is Apache-2.0, but `enterprise/` is under a separate source-available commercial license. Do not copy, package, redistribute, or use that directory's production features without a separate agreement.
- Apache-2.0 does not grant OpenMausBot/MausBot trademark rights. ORIENT must keep its own product identity and attribution notices if it ever redistributes upstream material.
- Prefer protocol interoperability. Any future code reuse requires a file-level license, NOTICE, dependency, and SBOM review.

## Verification gates

### Unit and contract tests

- MCP initialization and protocol negotiation
- Tool allowlist and strict schema validation
- Malformed JSON-RPC, oversized frames, unknown IDs/tools, and unexpected response shapes
- Total-operation timeout, process exit, and concurrency bounds for Phase 1; cancellation and restart recovery remain acceptance gates before any long-running or mutating Phase 2 operation
- Endpoint/origin validation, redirect refusal, and token redaction
- Idempotent dispatch and reconciliation before any retry

### Security tests

- Prompt injection embedded in bot profiles, transcripts, and tool results
- Cross-tenant bot/task access
- Missing, stale, revoked, and replayed approvals
- Unauthorized dispatch and unknown upstream tools denied
- Credential exfiltration attempts and logs/audit redaction
- OpenMausBot offline or compromised response cannot alter ORIENT policy or state

### Integration and acceptance

- ORIENT starts and passes tests when OpenMausBot is absent, stopped, or misconfigured
- Read-only discovery against a real local OpenMausBot instance
- Safe task dispatch only after owner approval (Phase 2)
- Upstream failed, stalled, needs-user, timed-out, and completed states mapped correctly
- Restart/reconciliation does not duplicate an external action
- Graceful shutdown terminates the MCP child process
- Exact-SHA Strict CI, CodeQL, secret scanning, and browser acceptance as applicable
- One real first-user workflow and a customer pilot/interview showing measurable coordination-time improvement

## Product and commercial success

The first customer hypothesis is a small software team that already uses multiple AI coding/research agents and needs one governed way to coordinate them. Validate with one workflow (for example, parallel code review and risk analysis) and measure:

- time from request to verified result versus the team's current workflow;
- number of duplicate or lost dispatches;
- percentage of actions with attributable approval and audit evidence;
- failure recovery and human-intervention time;
- willingness to keep using and pay for the governed coordination layer.

Do not expand this integration merely to increase the agent count or feature list. If it does not reduce a real customer's coordination cost or risk, stop after the read-only slice.

## Consequences

**Positive:** ORIENT gains access to a mature multi-agent desktop workflow without building another Electron application, raising its Node floor, or taking on a large dependency tree. The protocol boundary is independently testable and can support other external agent fleets later.

**Costs and limitations:** A second process must be installed and running; network/pairing configuration and version compatibility need support; upstream outages are possible; the first slice is read-only and will not deliver autonomous remote actions until the later approval and policy gates pass.


## Provider-neutral boundary

The application layer must not depend directly on an OpenMausBot MCP client or upstream tool names. External agent fleets are registered behind the normalized provider contract in `src/application/agents/external-agent-provider-registry.js`:

- `id`: stable, lowercase provider identifier;
- `health()`: provider health observation;
- `listAgents()`: normalized agent inventory observation;
- `listChannels()`: normalized channel inventory observation;
- `listModels()`: normalized model inventory observation.

Infrastructure adapters translate provider-specific protocols into this contract. The registry rejects malformed or duplicate providers and becomes immutable after startup registration. OpenMausBot is the first adapter; its MCP transport and upstream tool names remain isolated under `src/infrastructure/agents/`. The existing ORIENT ToolRegistry and capability governance remain the only path by which an agent can consume these observations.

Adding another provider must add an adapter and contract tests, not provider-specific branches in the runtime or planner. A provider may expose only the operations explicitly implemented by its adapter; the presence of additional upstream tools never expands the ORIENT contract. Mutating/delegating methods are intentionally absent from this first contract and require a separate approval-bound extension.
