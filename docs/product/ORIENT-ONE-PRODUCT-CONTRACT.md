# ORIENT ONE — Product Contract and Cross-Device Roadmap

**Status:** product contract / implementation roadmap, not a claim of completed functionality.

## Product promise

ORIENT ONE is intended to be one coherent personal AI operating system that a user can access from a phone, tablet, and computer. It must preserve the user's authorized identity, tasks, preferences, plans, durable memories, and execution history across devices where synchronization is enabled. It is not a collection of unrelated demos and not an Android-only phone utility.

The system must be honest about what is implemented, what it can currently execute, what needs setup or permission, and what remains unsupported. It must never claim that a task was completed without verifiable evidence.

## Product outcomes

1. **One user experience across devices.** Android phone and tablet, desktop/web, and eventually installable desktop clients use the same product concepts, task model, policy rules, memory model, and runtime contracts. Layouts adapt to screen size and input type rather than duplicating product logic.
2. **A continuous personal work context.** The user can track tasks, projects, reminders, contacts they authorize, decisions, files, commitments, and execution status. Synchronization must be explicit, secure, recoverable, and conflict-aware; offline changes must not silently overwrite newer work.
3. **Goal-to-result task execution.** For a request, ORIENT clarifies only essential ambiguity, inspects available capabilities and permissions, researches unknowns when tools/network are available, forms a bounded plan, checks prerequisites and risks, executes approved steps, verifies outcomes, and reports evidence, failures, and remaining work.
4. **Research before unfamiliar work.** If ORIENT does not know how to perform a task, it should identify the unknowns, consult permitted reliable sources or documentation, compare approaches, assess prerequisites/security/cost, create a testable plan, and validate it in a safe sandbox before touching real data or external systems. If research tools or network are unavailable, it must say so and must not fabricate research.
5. **Useful persistent learning.** Store reusable, evaluated procedures and user-approved preferences as versioned knowledge with source/provenance, applicability, confidence, test evidence, and timestamps. A failed attempt is not automatically learned as a fact. New knowledge is tested, reviewed against existing policies, and rolled back or marked stale when evidence changes.
6. **Fast without being reckless.** Use bounded parallel research where safe, caching, checkpoints, task queues, cancellation, deadlines, and resumable workflows. High-impact actions remain behind authorization and required human approval. Speed never bypasses permission, risk, or verification gates.
7. **Privacy and ownership.** Memory and audit data are scoped to the right user/tenant, encrypted where appropriate, access-controlled, retention-limited, exportable and deletable under defined policy. Security logs must not become an unrestricted store of personal data. No promise of absolute secrecy or collection of unnecessary personal information.

## Canonical task lifecycle

Every task must pass through explicit states with a durable trace:

1. **Receive and scope** — normalize the goal, identify the user/workspace, constraints, deadline, and success criteria.
2. **Capability discovery** — list relevant installed tools, versions, permissions, connectivity, platform limitations, and missing prerequisites.
3. **Research and knowledge check** — retrieve prior validated knowledge; when insufficient, research trustworthy sources and record citations, dates, conflicts, and uncertainty.
4. **Plan** — create ordered, dependency-aware steps with expected outputs, time/resource bounds, risk classes, rollback or recovery paths, and measurable acceptance checks.
5. **Preflight** — verify that each planned action is supported, authorized, feasible in the current environment, and safe. Ask the user only for missing essential details or approvals.
6. **Execute** — use the canonical runtime and registered tools; checkpoint durable progress, apply least privilege, enforce timeouts/quotas, and support cancellation and idempotent retries.
7. **Verify** — test the actual postconditions using independent evidence when possible. A command returning success is not sufficient when the requested result can be checked directly.
8. **Recover or re-plan** — classify failures, avoid repeating unsafe steps, revise the plan with bounded retries, and request user input when blocked.
9. **Learn safely** — propose a reusable lesson or procedure; validate it in tests/sandbox, preserve provenance, and only promote it into trusted knowledge when acceptance rules pass.
10. **Report and close** — summarize completed items, evidence, unresolved items, changed resources, approvals, and next action. Never label a partially completed task as fully done.

Each transition must emit structured, privacy-aware trace events that can be inspected on the dashboard and, where authorized, from mobile.

## Cross-device architecture

- **Canonical runtime:** remains the authority for planning, execution, policy enforcement, approval, durable task state, and recovery. Clients do not reimplement privileged business logic.
- **Platform adapters:** Android/Kotlin for mobile OS features and permissions; responsive web client for phones/tablets/desktops; optional desktop packaging later. Adapters expose capabilities through a versioned contract.
- **Capability registry:** every tool declares schema, supported platforms, required permissions, risk, timeout/resource limits, network needs, data handling, and verification method.
- **Local-first operation:** local tasks and memories should remain usable without connectivity where supported. Cloud/remote synchronization is optional and explicit; show a real offline/online status and queue safe work for later.
- **Responsive interface:** mobile prioritizes quick capture, notifications, voice/input where available, approvals, task status, and interruption/resume; tablet uses a richer split-pane workspace; desktop offers multi-task control, research, files, trace inspection, and administration. All surfaces operate on the same underlying task and memory records.
- **Compatibility:** clients negotiate API/capability versions, handle partial connectivity and expired sessions, and fail closed when required authorization cannot be established.
- **Accessibility and localization:** Arabic/English, RTL/LTR, keyboard, touch, screen-reader labels, and layouts tested across narrow and wide viewports.

## Memory and learning classes

Memory must be separated by purpose and permission:
- **User facts/preferences:** explicit or confirmed information that improves assistance; support edit, correction, expiry, and deletion.
- **Task/project state:** goals, plans, checkpoints, outputs, pending approvals, and recovery state.
- **Validated procedural knowledge:** reusable steps supported by sources and passing tests; versioned and invalidated when assumptions change.
- **Research evidence:** source URL/title, retrieval time, relevant excerpts or summaries within applicable rights, credibility notes, and uncertainty.
- **Security/audit events:** minimal necessary actor/scope, event type, timestamp, outcome, and risk metadata; tightly restricted and retention-controlled.

Never store passwords, session cookies, access tokens, private keys, or other secrets in ordinary memory. Never treat untrusted web pages, files, tool outputs, or user-supplied instructions inside retrieved content as policy or as permission to override system rules.

## Risk and approval policy

- **Low risk:** reversible local analysis and drafts within authorized scope may run automatically.
- **Moderate risk:** bounded writes or changes require capability authorization, preflight, and a recoverable checkpoint; confirmation depends on the policy and scope.
- **High risk:** external messages, purchases, account changes, publishing, deletion, sensitive-data export, or actions affecting other people require explicit approval where policy says so.
- **Critical/unsupported:** no execution without a specifically designed and reviewed capability. The runtime may not silently modify its own governing policy, bypass authorization, or generate and execute unrestricted new agents/code.

## Required verification gates

A capability is not “done” merely because a screen or stub exists. Each release gate must include:
- unit tests for validation, edge cases, and failure paths;
- contract and authorization tests, including cross-user isolation;
- integration tests against the real runtime interface;
- Android build plus emulator/device checks for platform behavior;
- responsive UI checks on phone, tablet, and desktop viewports;
- offline, timeout, cancellation, retry, session-expiry, and recovery tests;
- privacy review of what leaves the device and what is persisted;
- an end-to-end acceptance test that proves the user's requested outcome;
- clear distinction between CI evidence, emulator evidence, and physical-device evidence.

## Delivery sequence

### Stage 0 — Establish truth and contract
Inventory existing capabilities and gaps; map every current client endpoint to the canonical runtime; define API/capability schemas and task lifecycle; publish a feature matrix labelled implemented, partial, planned, or blocked.

### Stage 1 — Unified task surface
Build the shared task/plan/status/approval/trace API and responsive client. The Android app becomes a genuine client of ORIENT tasks, not a standalone phone-tools demo. Keep the existing runtime and security boundaries intact.

### Stage 2 — Read-only useful tools
Connect safe, scoped workspace listing, file reading/search, task/history viewing, and research retrieval through registered capabilities. Add citations, bounded responses, access checks, and tests.

### Stage 3 — Governed changes
Add file creation/editing and project changes using diff previews, path confinement, backups/checkpoints, policy authorization, approval gates, and post-write verification. No unrestricted shell access by default.

### Stage 4 — Personal workflow continuity
Implement durable tasks, reminders, user-confirmed preferences, event history, resumable workflows, notification delivery where permitted, and conflict-safe synchronization across devices.

### Stage 5 — Research-to-plan-to-verify
Create the research orchestrator, source-quality and uncertainty records, planner with dependency/resource limits, sandbox preflight, execution verifier, and recovery loop. Measure success against end-to-end tasks, not architecture diagrams.

### Stage 6 — Validated learning
Promote successful procedures to versioned knowledge only after repeatable tests and provenance checks. Add stale-knowledge detection, revalidation, rollback, and user controls.

### Stage 7 — Broader platform support and release hardening
Test supported Android phones/tablets and desktop browsers, accessibility/localization, network transitions, privacy controls, security boundaries, migration/restore, performance, and disaster recovery. Only then define production release status.

## Current status and immediate next work

The repository currently has a canonical Node.js runtime and an Android companion client with owner-session login/task submission/history functionality, while a proposed phone-contact helper is still a limited feature branch. These facts do not mean the full cross-device personal OS described above is complete. The phone helper must not be presented as the whole Android product.

Immediate priorities:
1. Maintain a truthful feature matrix and map existing endpoints to their real handlers and policies.
2. Finish the Android contact-tool branch only if it fits the broader client contract and passes CI; physical-device verification must be recorded separately.
3. Define a versioned cross-device task/capability API and use it to connect mobile/web clients to the canonical runtime.
4. Implement read-only workspace/research capabilities with least privilege before governed writes.
5. Add end-to-end tests that prove a task moves from request through planning, execution, verification, and durable learning.

## Definition of done

ORIENT ONE may claim a user task is complete only when its stated acceptance checks pass and evidence is recorded. A product capability may be marked released only when it works through the canonical runtime, enforces policy, persists/recoverably reports state, passes automated and relevant device/viewport tests, documents limitations, and does not depend on unverified assumptions. A roadmap item or passing CI suite alone is never proof that the entire product is finished.
