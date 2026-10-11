# Orion-AI-1 / Orioncv Adoption and Source Audit

**Status:** architecture contract mapped; related public historical repository inspected; no upstream implementation code imported  
**Target:** ORIENT ONE architecture on `main`, reviewed 2026-10-12  
**References:**  
- Architecture contract: https://github.com/elsaadani40-pixel/Orion-AI-1  
- Related historical application repository: https://github.com/elsaadani40-pixel/Orioncv  
- Reviewed Orioncv commit: `bfe1f45a4dc4fbc27b4f5813249b9a13b98d561a`  
**Purpose:** preserve useful, demonstrably safe ideas without creating a second runtime, duplicating services, weakening security boundaries, or claiming unverified implementation work.

## 1. Source inventory and identity

### 1.1 Orion-AI-1 architecture repository

The public `Orion-AI-1` repository currently contains only three tracked files on its `main` branch:

- `README.md`
- `AGENT.md`
- `docs/RFC-001-orient-one-v0.1.md`

It has no executable application source, test suite, package manifest, or runtime to port. The README says the complete implementation tree still needs to be pushed. This repository is an architectural reference, not a source-code donor.

### 1.2 Related `Orioncv` repository

The public `Orioncv` default branch resolves to commit `bfe1f45a4dc4fbc27b4f5813249b9a13b98d561a`. Its package metadata identifies a Next.js application named `orion-cv`, with resume/ATS features, OpenAI/Gemini integrations, Supabase, and UI dependencies. It is a career/resume application, not an isolated implementation of ORIENT's autonomous agent runtime.

The recursive Git tree contains 19,013 entries, including a large `.arch-backup` tree with vendored/copied dependency artifacts. No root `LICENSE`/ `LICENCE`/ `COPYING` file was found in that tree. Therefore the license and provenance needed to reuse source are **not established** by this review. The public `main` branch does not prove what may exist in the local `~/orioncv` recovery branch or its uncommitted working tree; that local state remains separately unaudited.

**Decision:** do not wholesale-copy or cherry-pick from `Orioncv`. Only concepts may be considered, and only after an ORIENT-specific gap, source provenance/license, behavior, and tests are established.

## 2. Source-level findings from Orioncv

The following are concrete review findings, not claims that every file or branch has been exhaustively audited.

| Source path | Finding | ORIENT decision |
|---|---|---|
| `lib/core/ai/contracts/ai-provider.ts` | A typed provider request/result union captures request identity, provider/model metadata, usage, and retryability. Its contract is tied to the resume app and differs from ORIENT's existing provider/runtime contracts. | **ADAPT conceptually** only where ORIENT has a demonstrated observability/error-contract gap; do not copy types wholesale. |
| `lib/core/ai/providers/gemini-provider.ts` | The API key is placed in the request URL; timeout/cancellation and token-usage accounting are not consistently represented in the shown path; role normalization maps all non-system messages to user/model. | **REJECT as-is**; require secret-safe transport, explicit timeout/cancellation, accurate usage, and role validation. |
| `lib/core/ai/providers/openai-provider.ts` | Provider construction throws if an environment key is missing; model choice is hard-coded. This is application-specific and not a governed, policy-driven routing adapter. | **REJECT as-is**; ORIENT's ModelRouter/provider boundary remains canonical. |
| `lib/core/ai/runtime/ai-runtime.ts` and `lib/core/ai/orchestrator/ai-orchestrator.ts` | These introduce additional execution/retry/timeout layers. The visible timeout races do not show timer cleanup in all paths; the orchestrator retries errors broadly rather than applying ORIENT's classified retry policy. | **REJECT as a runtime**; reuse no execution loop. Any retry idea must go through ORIENT's bounded retry/recovery policy. |
| `lib/core/ai/governance/control-plane.ts` | Credit checks, model calls, and credit deductions are application billing concerns. The visible read/modify/write flow is not an atomic ledger transaction. | **REJECT for ORIENT core**; no user-billing assumptions or non-atomic credit ledger in runtime authorization. |
| `lib/core/memory/types.ts`, `repository.ts`, `store.ts` | Memory types include `any`; persistence is keyed by `user_id`; the shown store does not express ORIENT tenant/workspace, agent capability, or operation-level memory policy. | **REJECT as a memory implementation**; ORIENT scoped access policy and repository boundary remain authoritative. |
| `lib/core/context/buildContext.ts` | Builds resume-specific context from memory, skills, and resume history. | **DO NOT PORT**; domain-specific context builder, not a general agent context contract. |
| `lib/core/graph/engine.ts` | A node-following loop has no visible execution-step ceiling, cycle detection, cancellation, authorization gate, or durable recovery in this file. | **REJECT**; ORIENT Runtime/AgentLoop owns bounded execution. |
| `__tests__/integration/security-isolation.test.ts` | The shown memory-isolation test asserts that two literal IDs differ; it does not exercise a repository/query or prove that User A cannot retrieve User B's row. Other tests in the file accept either a successful call or an exception, so they do not prove a strict success/failure contract. | **Do not treat as security evidence** for ORIENT; require real negative-path integration tests. |

These findings make the repository useful as a source of review questions and isolated design ideas, not as safe drop-in production code.

## 3. Non-negotiable integration rules

1. **One canonical execution owner.** `OrientRuntime` remains the entry point. Do not introduce an Orion runtime, alternate scheduler, or side-channel that executes tools independently.
2. **No implicit agent trust.** Agent identity alone grants no tool access. Agent definitions, capability governance, authorization, risk policy, and approval gates remain authoritative.
3. **No ungoverned self-building.** Runtime self-modification and arbitrary agent creation/execution remain out of scope for the initial product.
4. **Memory is not an execution channel.** Memory access remains scoped and authorized; tenant identity comes from trusted runtime context, not model/agent-supplied claims.
5. **Routing is policy-governed.** Model selection must remain observable and must not bypass provider policy or capability requirements.
6. **Recovery is bounded.** Retry/replan/resume/cancellation behavior must retain explicit limits, durable state where required, and observable terminal outcomes.
7. **Honest offline behavior.** If a network capability is unavailable, ORIENT must report that limitation rather than fabricate a network-derived result.
8. **No blind dependencies or wholesale copies.** No dependency, copied source, or license obligation is introduced by this adoption record.

## 4. Principle-to-implementation traceability

| Contract | Existing ORIENT boundary | Verification to extend if changed | Decision |
|---|---|---|---|
| One canonical Runtime owns execution | `src/core/runtime/orient-runtime.js`; request, agent, workflow, recovery and persistence coordinators | `test/unit/core/runtime/`; `test/integration/specialized-agent-runtime.test.js` | **KEEP** |
| Supervisor and specialized agent boundaries | `src/core/agent/orchestrator/agent-orchestrator.js`; agent definition and registry | `test/unit/core/execution/agent-boundary-enforcement.test.js`; specialized-agent runtime integration | **KEEP / ADAPT** at existing contracts only |
| Tool execution requires authorization | `src/core/tools/tool.registry.js`; tool execution authorization; authorization service | `test/unit/core/tools/tool-registry-execution-boundary.test.js`; risk-authorization tests | **KEEP** |
| High-risk changes require explicit approval | `src/core/agent/approval/approval-service.js`; authorization service | approval service, integrity, and pause/resume tests | **KEEP** |
| Agent-to-agent calls are allow-listed | `src/core/agent/invocation/agent-invocation-service.js`; definitions and registry | invocation-service and runtime boundary tests | **KEEP** |
| Model routing is policy-aware and observable | `src/core/model/model-router.js`; provider boundary under `src/infrastructure/model/` | model-router and runtime integration tests | **KEEP / ADAPT** concepts only |
| Memory access is scoped | `src/core/memory/memory-access-policy.js`; memory context provider and service | memory-access-policy and service-boundary tests | **KEEP** |
| Events, decision trace and recovery are first-class | `src/core/agent/observation/`; runtime recovery and persistence/checkpoint coordinators | execution-events and recovery unit/integration suites | **KEEP** |
| Bounded retries and deterministic failure | execution retry policy/executor and runtime recovery coordinators | execution/recovery suites | **KEEP** |
| Self-modification is out of scope | Runtime, tool/agent registration and capability-governance boundaries | boundary, registry, governance and project-builder policy tests | **REJECT** arbitrary mutation/creation |
| Offline behavior must be truthful | local model/provider policy and explicit network/tool availability | negative tests for offline/network-dependent capabilities | **KEEP** |

Paths are pointers to existing implementation and tests, not a claim that every concept is complete or production-certified.

## 5. Explicit KEEP / ADAPT / MIGRATE / REJECT policy

- **KEEP:** ORIENT's canonical Runtime, agent orchestrator, plan validation, ToolRegistry, authorization/approval, ModelRouter, scoped memory policy, event pipeline, persistence, and bounded recovery.
- **ADAPT:** concrete, testable improvements to provider metadata/error classification or decision trace only where a specific gap is demonstrated and existing ORIENT contracts can be improved without duplication.
- **MIGRATE:** no source files or dependencies in this change. Neither `Orion-AI-1` nor the reviewed `Orioncv` default branch currently provides a safe, license-cleared, tested implementation to import. The local `~/orioncv` recovery branch and uncommitted changes have not been inspected by this remote review.
- **REJECT:** parallel runtime/scheduler, duplicate decision/policy/router/memory engines, direct agent-to-tool execution, unrestricted shared memory, automatic high-risk approval, unbounded graph loops, broad retries, and early self-modifying/self-creating agents.

## 6. Requirements before any code migration

Any later Orion-derived code or behavior change must include all of the following in its own branch/PR:

1. Exact upstream repository URL, immutable commit SHA, file list, and applicable license/notices.
2. A concrete ORIENT gap and reason existing modules cannot address it.
3. Threat-model and tenant-isolation review wherever identity, memory, tools, network, or external state are involved.
4. Unit and integration tests for allowed and denied paths, including failure, timeout, cancellation, and recovery behavior.
5. Evidence that all execution still passes through the canonical Runtime and authorization/approval gates.
6. Full Strict CI for the exact proposed head; never reuse CI results from an earlier commit.
7. Independent review before merge; no direct write to `main`.

## 7. Acceptance status

- [x] Read public Orion-AI-1 README, engineering constitution, and v0.1 RFC.
- [x] Verify Orion-AI-1 has no executable source tree to cherry-pick.
- [x] Inspect the public Orioncv tree at immutable commit `bfe1f45a4dc4fbc27b4f5813249b9a13b98d561a` and review representative provider, runtime, memory, graph, and security-test files.
- [x] Record concrete source risks and explicit adoption/rejection decisions.
- [x] Map architectural requirements to ORIENT modules and existing tests.
- [ ] Run Strict CI on this updated audit commit.
- [ ] Complete independent review before merge.

**Completion definition:** this is an architecture and source-audit step, not a source-code port and not a claim that ORIENT is production-ready. The exact local recovery state at `~/orioncv` is not available through the public repository view and must not be represented as reviewed.
