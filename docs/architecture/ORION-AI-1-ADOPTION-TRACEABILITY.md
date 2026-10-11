# Orion-AI-1 Architecture Adoption and Traceability

**Status:** source review recorded; architecture alignment mapped; no upstream implementation code imported  
**Target:** ORIENT ONE `main` architecture as reviewed on 2026-10-12  
**Upstream reference:** https://github.com/elsaadani40-pixel/Orion-AI-1  
**Purpose:** preserve useful architectural intent from Orion-AI-1 without creating a second runtime, duplicating existing services, weakening security boundaries, or claiming unverified implementation work.

## 1. Source review result

The public `Orion-AI-1` repository currently contains only these three tracked files on its sole `main` branch:

- `README.md`
- `AGENT.md`
- `docs/RFC-001-orient-one-v0.1.md`

The repository metadata reports a very small repository (size 4); its tracked tree has no application source, test suite, package manifest, vendored dependencies, or executable runtime to port. The README explicitly describes the repository as a bootstrap and says the complete implementation source tree still needs to be pushed.

**Consequence:** a source-code cherry-pick or dependency migration from this public repository is not possible or justified. This change adopts its architectural contract as a traceable reference against ORIENT's existing implementation. It does not claim to import implementation code from Orion-AI-1. If a separate historical source tree exists (for example, a local development workspace), it must be reviewed as a distinct source with its own exact commit, file inventory, tests, and license evidence before code can be considered.

## 2. Non-negotiable integration rules

1. **One canonical execution owner.** `OrientRuntime` remains the execution entry point. Do not introduce an Orion runtime, alternate scheduler, or side-channel that executes tools independently.
2. **No implicit agent trust.** Agent identity alone grants no tool access. Agent definitions, capability governance, authorization, risk policy, and approval gates remain authoritative.
3. **No ungoverned self-building.** Runtime self-modification and arbitrary agent creation/execution remain out of scope for the initial product.
4. **Memory is not an execution channel.** Memory access remains scoped and authorized; tenant identity comes from trusted runtime context, not model/agent-supplied claims.
5. **Routing is policy-governed.** Model selection must remain observable and must not bypass provider policy or capability requirements.
6. **Recovery is bounded.** Retry/replan/resume/cancellation behavior must retain explicit limits, durable state where required, and observable terminal outcomes.
7. **Honest offline behavior.** If a network capability is unavailable, ORIENT must report that limitation rather than fabricate a network-derived result.
8. **No blind dependencies or wholesale copies.** No dependency, copied source, or license obligation is introduced by this adoption record.

## 3. Principle-to-implementation traceability

| Orion-AI-1 contract | Existing ORIENT implementation boundary | Existing verification to extend if that boundary changes | Adoption decision |
|---|---|---|---|
| One canonical Runtime owns execution | `src/core/runtime/orient-runtime.js`; request, agent, workflow, recovery and persistence coordinators under `src/core/runtime/` | `test/unit/core/runtime/`; `test/integration/specialized-agent-runtime.test.js` | **KEEP** existing owner; reject a parallel runtime |
| Supervisor and specialized agent boundaries | `src/core/agent/orchestrator/agent-orchestrator.js`; `src/core/agent/boundary/agent-definition.js`; `src/core/agent/boundary/agent-registry.js` | `test/unit/core/execution/agent-boundary-enforcement.test.js`; `test/integration/specialized-agent-runtime.test.js` | **KEEP / ADAPT** only at existing contracts |
| Tool execution requires authorization | `src/core/tools/tool.registry.js`; `src/core/tools/tool-execution-authorization.js`; `src/core/agent/authorization/authorization-service.js` | `test/unit/core/tools/tool-registry-execution-boundary.test.js`; `test/unit/core/agent/risk-authorization.test.js` | **KEEP**; never create a bypass adapter |
| High-risk changes require explicit approval | `src/core/agent/approval/approval-service.js`; `src/core/agent/authorization/authorization-service.js` | `test/unit/core/agent/approval-service.test.js`; `test/unit/core/agent/approval-integrity.test.js`; approval-pause integration tests | **KEEP**; approval must remain bound to execution/step/plan scope |
| Agent-to-agent calls are allow-listed | `src/core/agent/invocation/agent-invocation-service.js`; agent definitions and registry | `test/unit/core/agent/agent-invocation-service.test.js`; `test/unit/core/execution/agent-invocation-runtime.test.js` | **KEEP**; no implicit trust between agents |
| Model routing is policy-aware and observable | `src/core/model/model-router.js`; provider boundary under `src/infrastructure/model/` | `test/unit/core/model/model-router.test.js`; `test/unit/core/agent/model-router-runtime.test.js` | **KEEP / ADAPT** policy ideas only; do not import another router |
| Memory access is scoped | `src/core/memory/memory-access-policy.js`; `src/core/agent/context/memory-context-provider.js`; `src/application/memory/memory.service.js` | `test/unit/core/memory/memory-access-policy.test.js`; `test/unit/core/memory/memory-service-boundary.test.js` | **KEEP / ADAPT** memory concepts without duplicating storage or bypassing authorization |
| Events, decision trace and recovery are first-class | `src/core/agent/observation/`; `src/core/runtime/execution-recovery-coordinator.js`; persistence and checkpoint coordinators | `test/unit/core/runtime/execution-events.test.js`; `test/unit/core/runtime/execution-recovery-coordinator.test.js`; recovery integration tests | **KEEP** existing event/recovery pipeline |
| Bounded retries and deterministic failure | `src/core/execution/policy/retry-policy.js`; `src/core/execution/retry/retry-executor.js`; runtime recovery coordinators | Existing execution/recovery unit and integration suites | **KEEP**; no silent privilege escalation or unbounded retries |
| Self-modification is out of scope | Runtime/tool/agent registration and capability-governance boundaries | Boundary, registry, capability-governance and project-builder policy tests | **REJECT** arbitrary runtime mutation or agent creation/execution |
| Offline behavior must be truthful | Local model/provider policy and explicit network/tool availability handling | Add negative tests whenever an offline/network-dependent capability changes | **KEEP** as a product invariant; no fabricated remote results |

Paths above are implementation and test pointers, not a claim that every Orion-AI-1 concept is already complete or production-certified. Existing test files provide relevant behavioral coverage; any future change to a mapped boundary must run the corresponding tests and full Strict CI.

## 4. Explicit KEEP / ADAPT / MIGRATE / REJECT policy

- **KEEP:** ORIENT's canonical Runtime, existing agent orchestrator, plan validation, ToolRegistry, authorization/approval services, ModelRouter, memory policy, event pipeline, persistence, and bounded recovery.
- **ADAPT:** only concrete, testable contract improvements from the RFC (clearer boundaries, decision metadata, memory provenance/scoping, deterministic recovery) when a gap is demonstrated against current code.
- **MIGRATE:** no source files or dependencies from the public Orion-AI-1 repository in this change, because that repository contains no executable source tree. Any separately located legacy code requires a separate source-level review before migration.
- **REJECT:** parallel runtime/scheduler, duplicate decision/policy/router/memory engines, direct agent-to-tool execution, unrestricted shared-memory access, automatic approval of high-risk actions, and early self-modifying/self-creating agents.

## 5. Change protocol for future adoption

Any later Orion-derived code or behavior change must include all of the following in its own branch/PR:

1. Exact upstream repository URL, immutable commit SHA, file list, and applicable license/notices.
2. A concrete ORIENT gap and reason existing modules cannot address it.
3. A threat-model and tenant-isolation review where identity, memory, tools, network, or external state are involved.
4. Unit and integration tests for allowed and denied paths, including failure/recovery behavior.
5. Evidence that all execution still passes through the canonical Runtime and authorization/approval gates.
6. Full Strict CI results for the exact proposed head; do not reuse CI results from an earlier commit.
7. Independent review before merge. No direct write to `main`.

## 6. Acceptance status

- [x] Read the public Orion-AI-1 README, engineering constitution, and v0.1 RFC.
- [x] Verify the public repository tree and its only branch; no executable source is present to cherry-pick.
- [x] Map key architectural requirements to ORIENT implementation modules and existing behavior tests.
- [x] Record explicit adoption and rejection decisions.
- [ ] Obtain green Strict CI for this documentation-only change.
- [ ] Keep this PR unmerged until review and CI complete.

**Completion definition:** this record is a completed architecture-alignment step, not a claim that the entire historical Orion codebase (if any exists elsewhere) has been merged, nor a claim that ORIENT is production-ready.
