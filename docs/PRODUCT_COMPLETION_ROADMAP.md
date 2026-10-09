# ORIENT ONE — Product Completion Roadmap

**Status:** execution plan; not a declaration of production readiness  
**Baseline reviewed:** `main` after Project Builder resource-enforcement follow-up  
**Product objective:** turn the existing runtime into a usable, local-first personal agent through tested end-to-end capabilities—not an endless sequence of architecture-only changes.

## Operating rules

1. **Evidence before status.** Mark a capability complete only when its implementation, tests, and user-visible behavior have been checked. Green CI proves only the scenarios it executes.
2. **One canonical execution owner.** Keep planning, authorization, approvals, tool execution, persistence, observation, and recovery behind the canonical runtime. Do not add parallel execution paths.
3. **Fail closed.** If authorization, required approval, sandboxing, persistence guarantees, or a required dependency is unavailable, do not silently downgrade to an unsafe mode.
4. **Vertical slices over scaffolding.** Prefer a working user outcome from request to verified result over adding another abstraction without user value.
5. **No circular re-audits.** Reopen a closed area only when a regression, new threat, or concrete code/test evidence justifies it.
6. **Zero-budget / replaceable dependencies.** Prefer local and open-source options; optional providers must not become mandatory paid dependencies.
7. **Every phase ends with evidence:** tests, a reproducible usage example, updated docs, CI results, and a clear list of limitations.

## Baseline facts observed

- The README describes the repository as active engineering / pre-release and explicitly warns that not all planned capabilities are production-ready.
- The package exposes `npm test` and `npm run check:syntax`; Strict CI includes Node 20/22/24 unit and architecture tests, sandbox prerequisites, PostgreSQL integration, and full repository tests.
- The code contains a canonical `OrientRuntime`, request/workflow/agent/recovery coordinators, authorization and approval services, tool execution authorization, and a Project Builder path with OS-level sandbox/resource enforcement.
- The HTTP server exposes memory routes and agent execution/status/approval/cancel/resume endpoints. PR #130 fixed async PostgreSQL status/approval reads; PR #132 added a real HTTP-to-runtime read-only mission; PR #133 closes direct calls through a registered tool returned by `ToolRegistry.get()` when authorization is enabled.
- Configuration defaults to JSON persistence and localhost binding; the model provider defaults to `none`, with an Ollama URL/model configured as an option.
- The repository currently has no open issues or open pull requests at the time this baseline was queried.
- Version metadata drift was resolved in PR #128: `package.json` is now the source of truth (`0.12.0`), and both application config and `OrientRuntime.version` read the shared `src/core/version.js` value. `test/unit/core/version-consistency.test.js` guards package/config consistency.
- The recent Strict CI success (6/6 jobs, 476 passing and 0 failing in the reported full-suite logs) validates that run, not every security property or every future product requirement.

## Delivery phases

### Phase 0 — Establish a truthful baseline

**Goal:** make the repository's status and release identity internally consistent.

- [x] Reconcile package/runtime version metadata and add a regression test so the values cannot silently drift (PR #128 merged; Strict CI run #37984907052 succeeded 6/6 jobs).
- [ ] Verify documented commands and configuration defaults against the actual entry point.
- [x] Publish a capability matrix with three states only: implemented-and-verified, implemented-but-unverified, planned (see `docs/CAPABILITY_MATRIX.md`).
- [ ] Record current CI run links and the exact checks included; do not infer untested behavior.

**Exit gate:** version/config tests pass; README setup instructions are reproducible; capability claims link to code/tests.

### Phase 1 — Prove the governed execution boundary

**Goal:** one request cannot reach a sensitive tool or subprocess by bypassing policy.

- [ ] Trace every tool invocation from the canonical runtime to the registry's final execution boundary.
- [ ] Verify authorization bindings cannot be forged or reused for a different tool, agent, execution, step, or plan revision.
- [ ] Verify high-risk approval is bound to tenant, execution, step, tool/capability, plan revision, agent/operation where applicable, and is consumed atomically exactly once.
- [ ] Exercise denial, missing approval service, expired/replayed approval, tenant mismatch, cancellation, timeout, and recovery/resume cases.
- [ ] Trace every Project Builder subprocess call; require OS sandbox/resource controls and fail closed if prerequisites are unavailable.
- [ ] Check cleanup races and concurrent quota semantics. Per-command quotas must not be described as aggregate tenant quotas.

**Exit gate:** an explicit call-site inventory, regression tests for bypass/failure cases, and green Strict CI. If the reviewed boundary has no demonstrated gap, close the audit without inventing a code change.

### Phase 2 — Deliver one complete local-first agent workflow

**Goal:** a user can submit a real task and observe a trustworthy outcome through the public application interface.

- [ ] Trace the HTTP `POST /agent` path end to end: input validation → planning → plan validation → authorization/approval → tool execution → persistence/events → evaluation → response.
- [x] Add a reproducible smoke scenario using only local/test fixtures and no paid API (PR #132; broader approval/resume/error-state coverage remains open).
- [ ] Return stable execution identifiers and status; make blocked, awaiting-approval, failed, cancelled, and completed states distinguishable.
- [ ] Verify request limits, malformed input, client disconnect/cancellation, and internal-error responses.
- [ ] Provide a documented CLI/curl example and expected response for the working slice.

**Exit gate:** a clean install can run the documented scenario from request to verified result; tests assert both success and blocked/failure behavior.

### Phase 3 — Make memory useful, scoped, and durable

**Goal:** relevant user context survives restarts and is retrieved only within its permitted scope.

- [ ] Prove JSON persistence behavior and PostgreSQL persistence behavior separately.
- [ ] Add end-to-end tests for add → retrieve/use → restart → retrieve, deletion, tenant/scope isolation, and malformed/corrupt state recovery.
- [ ] Establish a clear memory model separating durable user facts, task/execution state, and transient context.
- [ ] Add retrieval/relevance evaluation fixtures; never invent memories or return another tenant's data.
- [ ] Document export, backup, deletion, and migration behavior before treating memory as production-ready.

**Exit gate:** durable memory tests pass against actual configured backends; isolation and deletion have regression coverage.

### Phase 4 — Reliable tool and integration system

**Goal:** tools have explicit contracts and failures are observable/recoverable.

- [ ] Define a versioned tool contract: schema, capability/risk, timeout, idempotency, side effects, cancellation, output limits, and error shape.
- [ ] Prove retry/idempotency behavior for transient failures and non-repeatable actions.
- [ ] Add a minimal high-value local tool set first; add network/external adapters only with explicit permission and honest offline behavior.
- [ ] Ensure every tool result is recorded, bounded, and evaluated before the runtime claims success.
- [ ] Add adapter contract tests so future providers can be replaced without redesigning the core.

**Exit gate:** a task with multiple dependent steps can execute, recover safely from an injected failure, and produce a verifiable final result.

### Phase 5 — Usable operator experience

**Goal:** the runtime is operable by a real person, not only through internal tests.

- [ ] Provide a minimal accessible UI or CLI for task submission, progress, approval requests, execution history, cancellation, and recovery.
- [ ] Show why an action is blocked and what approval is needed; do not hide policy decisions.
- [ ] Show honest unavailable/offline/provider states and avoid fabricated success.
- [ ] Add structured diagnostics and redaction for secrets and personal data.
- [ ] Keep the service bound to localhost by default; document authentication and deployment requirements before remote exposure.

**Exit gate:** a user can start, monitor, approve/deny, cancel, and inspect a task without editing source code.

### Phase 6 — Android as a governed adapter, not a second runtime

**Goal:** Android capabilities become controlled tools backed by the same authorization model.

- [ ] Define a narrow adapter contract for permissions, contacts, notifications, intents, audio/microphone, and background events.
- [ ] Require platform permission and user approval where applicable; minimize collected data.
- [ ] Keep Android adapters from directly bypassing the canonical runtime/policy.
- [ ] Test denied permissions, revoked permissions, process death, offline operation, and duplicate events.
- [ ] Treat the Android app as a separate delivery artifact with its own build/test gates; do not mark it complete from backend CI.

**Exit gate:** at least one useful Android workflow is demonstrated end to end with explicit permissions and recovery behavior.

### Phase 7 — Release and operations

**Goal:** make installation, upgrades, support, and security boundaries understandable.

- [ ] Pin supported runtime versions and dependencies; produce a clean-install test.
- [ ] Define configuration validation, schema/data migrations, backup/restore, graceful shutdown, and rollback.
- [ ] Add resource/concurrency limits at the tenant/workflow level where required by product guarantees.
- [ ] Add operational health/readiness signals and redacted logs.
- [ ] Publish threat model, known limitations, supported platforms, installation instructions, and release notes.
- [ ] Add a license only after the owner selects one; until then, do not imply reuse rights.

**Exit gate:** reproducible installation and upgrade/rollback checks pass; limitations are public; a tagged release has a complete evidence bundle.

## Priority order

1. Phase 0: resolve release/version truth and baseline.
2. Phase 1: verify the execution boundary once, using evidence.
3. Phase 2: finish the first end-to-end local workflow.
4. Phase 3: prove durable, scoped memory.
5. Phase 4: harden useful tools and recovery.
6. Phase 5: deliver operator usability.
7. Phase 6: add Android through governed adapters.
8. Phase 7: package and release.

Security work is not a separate infinite project: it is a gate embedded in each phase. A phase is not blocked by speculative future audits, but a demonstrated critical bypass blocks the affected execution path until fixed.

## Completion definition

ORIENT ONE is not “finished” because a CI run is green or because the architecture has many components. The first meaningful product milestone is achieved when a clean installation can accept a user task, use scoped memory, create and validate a plan, request and enforce approval for consequential actions, execute authorized tools, persist and report the outcome, and recover safely from an injected failure—with an end-to-end test proving that entire path.

The broader product is release-ready only when the supported workflows, installation/upgrade path, security limitations, data handling, and operator experience are documented and verified.