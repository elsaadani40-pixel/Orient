# Open-Source Reference Audit for ORIENT ONE

**Review date:** 2026-10-09  
**Scope:** Architecture and security fit assessment of five upstream repositories.  
**Status:** Research/documentation only. No upstream source code, dependencies, or runtime behavior has been imported or changed by this audit.

## Executive decision

Do **not** replace ORIENT ONE's runtime or copy any repository wholesale. Use the five projects as targeted references, with a small, evidence-driven adoption plan:

1. **Immediate security reference:** Anthropic Sandbox Runtime (SRT), to compare filesystem/network policy composition and fail-closed configuration behavior against ORIENT's existing Bubblewrap + systemd/cgroup execution boundary.
2. **Immediate reliability reference:** Mem0 and Letta, for memory retrieval/evaluation ideas only after the existing JSON-memory concurrency/data-integrity issue is resolved.
3. **Runtime architecture reference:** ZeroClaw, for provider/tool/channel interfaces and least-privilege defaults; translate concepts into TypeScript rather than importing its Rust runtime.
4. **Integration reference:** OpenClaw, for channel/tool integration patterns only. Its published security policy explicitly says its gateway is not designed as a shared multi-tenant boundary between adversarial users, so its trust assumptions must not be copied into ORIENT.

No dependency should be added until a separate proposal includes a concrete ORIENT use case, license/dependency review, threat-model impact, tests, and measurable acceptance criteria.

## ORIENT baseline observed

- package.json identifies ORIENT ONE as CommonJS, Node.js >=20, version 0.9.0; the current dependency list contains pg. The main test command is node --test.
- Project Builder uses Bubblewrap as a mandatory Linux isolation boundary and launches it through a transient systemd user service with cgroup/resource-limit enforcement. The code explicitly refuses an unsandboxed fallback and refuses non-Linux execution.
- Project Builder resource quotas are proposed in open PR #114. Its latest Strict CI run (#1458) passed all six jobs, but no independent review is recorded and the PR remains unmerged; this audit does not authorize merging it.
- The original JSON-memory check-then-create race tracked by issue #115 is addressed by the candidate changes in open PR #117: temporary-file initialization with atomic no-clobber publication, locked migration re-read, and multi-process stress tests. Strict CI #1460 passed all six jobs, but the PR remains unmerged and has no independent review. Treat the fix as proposed, not as part of main.
- ORIENT's non-negotiable boundary remains: one central Runtime/Supervisor; explicit capability authorization and risk policy; human approval for high-risk actions; no autonomous self-modification or agent creation/execution in the initial product.

## Repository-by-repository assessment

### 1. ZeroClaw — runtime and interfaces

Upstream: https://github.com/zeroclaw-labs/zeroclaw  
License signals checked: README advertises MIT OR Apache-2.0; the repository's LICENSE-APACHE is Apache-2.0. Before copying any code, also preserve the exact upstream license/notice files and verify the corresponding MIT license and any file-level notices.

**Useful research targets**
- Trait-driven, swappable provider/channel/tool boundaries.
- Secure-by-default runtime configuration and explicit security tests.
- Separation between core execution and integrations.

**Fit for ORIENT**
- Map its interfaces to ORIENT's existing ToolRegistry, Model Router/provider boundary, capability registry, and policy authorization. Prefer adapting interface ideas in TypeScript over adding a Rust subsystem.
- Compare its shell/file tool tests against ORIENT's own authorization and sandbox tests; use adversarial test cases, not feature-count comparisons.

**Risks / do not copy blindly**
- A different language/runtime creates maintenance and operational cost.
- “Secure-by-default” claims are not proof that a particular feature is safe for ORIENT's threat model.
- Verify the exact upstream repository and owner before relying on forks or binaries; the project has published warnings about impersonating repositories/domains.

**Decision:** Architecture/test reference; no runtime replacement.

### 2. OpenClaw — channels and tool integration

Upstream: https://github.com/openclaw/openclaw  
License: MIT (LICENSE inspected).

**Useful research targets**
- Integration/channel boundaries and packaging patterns for connecting an agent to external services.
- Clear operator trust assumptions and private security disclosure process.

**Fit for ORIENT**
- Use it to define future adapter contracts (channel adapter -> authenticated request -> capability check -> risk classification -> approved tool invocation -> audit event).
- Any connector must be denied by default, scoped to a tenant/user, and unable to bypass ORIENT's Runtime/authorization gates.

**Risks / explicit boundary**
- OpenClaw's own SECURITY.md states that its gateway is not designed as a shared multi-tenant boundary between adversarial users. ORIENT must not inherit that assumption if it intends to serve multiple customers.
- External channels increase prompt-injection, credential-handling, webhook-authentication, replay, and data-exfiltration risks.

**Decision:** Integration-pattern reference only; do not reuse its trust model as ORIENT's security model.

### 3. Letta / Letta Code — stateful agents and long-horizon memory

Current project entry: https://github.com/letta-ai/letta  
Current active code indicated by its README: https://github.com/letta-ai/letta-code  
License: Apache-2.0 (letta-code/LICENSE inspected).

**Useful research targets**
- Explicit separation of agent state, durable memory, identity, and conversation context.
- Memory lifecycle and evaluation approaches for long-running tasks.

**Fit for ORIENT**
- Derive a memory design note after issue #115 is fixed: distinguish raw events, durable facts, task state, and derived summaries; preserve provenance and timestamps; scope all retrieval by tenant and authorization.
- Add tests for stale/conflicting facts, deletion, retention, tenant isolation, and restart/recovery before considering semantic retrieval.

**Risks / do not copy blindly**
- Letta Code describes agents that can rewrite memory, skills, prompts, and even their harness through mods. That self-modifying behavior conflicts with ORIENT's initial safety boundary and must remain disabled/out of scope.
- Do not assume an old Letta server repository/branch is the currently maintained implementation; upstream says active source moved to letta-code.

**Decision:** Memory/state model reference; no self-modifying agent behavior.

### 4. Mem0 — memory extraction and retrieval

Upstream: https://github.com/mem0ai/mem0  
License: Apache-2.0 (LICENSE inspected).

**Useful research targets**
- Memory extraction, entity linking, hybrid retrieval, temporal ranking, and evaluation methodology.
- The repository includes a TypeScript package (mem0-ts), which may be a better language fit than adopting a Python-only path.

**Fit for ORIENT**
- First fix JSON-store atomic initialization, migration safety, and multi-process write integrity.
- Then create a benchmark using ORIENT-specific synthetic cases: conflicting updates, dated facts, deleted facts, tenant separation, exact identifier lookup, and retrieval precision/latency.
- Prototype retrieval behind an interface so the durable repository and authorization rules remain authoritative.

**Risks / evidence quality**
- The README distinguishes managed-platform benchmarks from the open-source SDK and notes that proprietary optimizations are not available in the OSS SDK. Do not assume headline benchmark scores will transfer.
- A memory layer must not silently overwrite facts, leak cross-tenant data, or treat model-generated inferences as verified user facts.

**Decision:** Candidate for a separately benchmarked memory adapter after issue #115; do not add a dependency yet.

### 5. Anthropic Sandbox Runtime (SRT) — OS-level isolation and network filtering

Upstream: https://github.com/anthropics/sandbox-runtime  
License: Apache-2.0 (LICENSE inspected).  
The README describes it as a **Beta Research Preview**; its security page currently exposes a published low-severity network-sandbox escape advisory (GHSA-9gqj-5w7c-vx47, published 2025-12-04). Review the advisory and fixed versions before using or vendoring code.

**Useful research targets**
- Explicit filesystem allow/deny policy semantics.
- Network allowlists enforced through a proxy plus OS-level egress fencing.
- Strict configuration validation and fail-closed behavior when a configuration file is invalid.
- Whole-process-tree isolation and platform-specific threat-model documentation.

**Fit for ORIENT**
- Compare policy semantics with ORIENT's Bubblewrap mounts and --unshare-all; document what is and is not allowed to access the network.
- Consider an isolated design spike for controlled network access only if Project Builder has a real requirement to fetch dependencies. Default should remain no network access.
- Extend tests to prove malformed/missing required security configuration cannot silently downgrade restrictions.

**Risks / do not copy blindly**
- SRT is a beta/research preview, not a drop-in proof of safety.
- Network filtering is complex; the README warns that broad domain allowlists can permit data exfiltration and that private-address protections depend on policy.
- Do not replace ORIENT's systemd/cgroup resource quotas with SRT; SRT's primary purpose is filesystem/network sandboxing, while ORIENT's current layer also imposes CPU/memory/process/file limits.
- Do not vendor the current implementation until the published advisory, fix status, transitive dependencies, and platform-specific behavior have been reviewed.

**Decision:** Security design/test reference; no immediate dependency or replacement.

## Cross-project recommendations mapped to ORIENT

| Priority | ORIENT gap / opportunity | Reference | Proposed action | Acceptance evidence |
|---|---|---|---|---|
| P0 | Suspected concurrent JSON memory initialization/data-loss race | ORIENT issue #115; Mem0/Letta concepts only after integrity fix | Reproduce with multi-process stress test; implement atomic no-clobber initialization; audit migration and locking | Repeated Linux stress runs preserve every successful insert; tenant isolation and durability tests pass |
| P0 | Resource-limited process termination must report actual cleanup outcome | ORIENT Project Builder branch / tests | Fix terminate() truthfulness and verify service/cgroup termination before claiming success | Tests cover kill/stop/reset failures, still-running child, and normal termination; Strict CI green |
| P1 | Network access policy for generated commands needs an explicit product decision | SRT | Keep default deny; document whether dependency downloads are required; prototype policy separately | Negative tests for unauthorized domains, loopback/private targets, DNS rebinding considerations, and exfiltration paths |
| P1 | Adapter integration must never bypass authorization | OpenClaw + ZeroClaw | Define a TypeScript adapter contract with identity, tenant, capability, risk, approval, and audit fields | Architecture tests prove all adapter invocations pass through the canonical authorization gate |
| P1 | Long-term memory quality needs measurable evaluation | Letta + Mem0 | Build a small deterministic benchmark only after data integrity is fixed | Precision/recall or task-success baseline, temporal/conflict cases, tenant isolation, deletion/retention tests |
| P2 | Provider/tool interfaces may need simplification | ZeroClaw | Compare existing interfaces before changing them; document duplication and migration cost | RFC demonstrates a concrete reduction in coupling without weakening policy or authorization |

## License and supply-chain gate before any code adoption

- Review the repository license plus licenses/notices for every copied file and transitive dependency; a repository-level license alone may not cover every asset.
- Record exact upstream URL, commit SHA, file paths, modification notices, license text, and rationale in a third-party notices inventory.
- Run dependency/license scanning and vulnerability review against the exact pinned commit, not just the current README.
- Prefer a small isolated adapter or a documented design pattern over copying a full framework.
- Do not add paid API/platform dependencies; keep ORIENT's local-first and open-source-first constraints.
- Do not merge adoption work directly to main; use a separate branch/PR with tests and independent review.

## Recommended execution sequence

1. Complete independent security review of PR #114, including termination truthfulness and resource-enforcement evidence; merge only after review approval.
2. Complete independent review of PR #117's atomic initialization, migration, lock ownership, and filesystem-error handling; merge only after review approval.
3. Publish a small memory-evaluation RFC based on Letta/Mem0, with no dependency initially.
4. Write the adapter contract and threat model from ZeroClaw/OpenClaw patterns.
5. Only then run a bounded SRT network-policy experiment if a real use case requires outbound network access.

## Evidence and limitations

This is a source-level reference audit based on the repositories' current public README, license, and security-policy files, plus a read of ORIENT's package.json, Project Builder isolator, and JSON memory repository. It is **not** a complete independent source audit of all five upstream codebases, a legal opinion, or proof that any upstream project is secure. The SRT advisory must be checked for affected/fixed versions before adoption. No production-readiness claim is made.
