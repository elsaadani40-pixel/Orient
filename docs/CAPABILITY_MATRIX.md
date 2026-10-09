# ORIENT ONE Capability Matrix

**Purpose:** separate working code from verified product behavior. This matrix is deliberately conservative and must be updated when evidence changes.

## Status definitions

- **Implemented and verified** — relevant source exists and an automated test or CI job exercises the stated behavior. This does not imply exhaustive assurance.
- **Implemented but unverified end to end** — source exists, but this review did not find a complete reproducible user-facing proof for the capability.
- **Planned** — not demonstrated as a working capability in the current ORIENT ONE repository baseline.

## Current matrix

| Capability | Status | Evidence / limits |
|---|---|---|
| Canonical runtime coordinates request execution, agent loop, persistence, workflow scheduling, and recovery | Implemented and verified | `src/core/runtime/orient-runtime.js`; `src/core/execution/agent-loop.js`; integration missions run under Strict CI. |
| Plan validation rejects unknown/unregistered tools | Implemented and verified | `src/core/planning/validation/plan-validator.js`; local-model planning boundary tests and Strict CI. |
| Tool capability authorization and high-risk approval flow | Implemented and verified for covered scenarios | `src/core/agent/authorization/authorization-service.js`; `src/core/agent/approval/approval-service.js`; high-risk integration mission. This is not an independent security certification. |
| Single-use approvals backed by durable persistence | Implemented and verified for covered scenarios | Approval service plus JSON/PostgreSQL persistence paths and integration tests. Atomicity guarantees must continue to be tested against the real repository implementation. |
| JSON and PostgreSQL durable execution state | Implemented and verified for covered scenarios | Persistence factory/adapters and PostgreSQL integration CI. This does not prove every crash or migration scenario. |
| Execution status and approval endpoints with async persistence support | Implemented and verified for covered scenarios | Runtime/HTTP route regression tests added in PR #130; Strict CI passed on the PR before merge. |
| Project Builder workspace policy, OS sandbox, and per-command resource enforcement | Implemented and verified on supported CI environment | `src/core/agent/project-builder/workspace/command-runner.js` and `bubblewrap-isolator.js`; sandbox and quota tests in Strict CI. Per-command limits are not aggregate tenant quotas; kernel escape is outside these guarantees. |
| Optional local Ollama planning provider | Implemented but unverified end to end | Provider/router/plan validation code and contract tests exist. A live local model's quality, availability, and end-user workflow are not proven by CI alone. |
| HTTP API request-to-final-result workflow against the complete app composition | Implemented but unverified end to end | `app.js`, `src/interfaces/http/server.js`, and agent routes exist. Route and runtime tests do not by themselves prove every request/approval/resume path through a running app. |
| Durable personal memory with relevance-quality guarantees | Implemented but unverified end to end | Memory services, scope policy, audit events, and persistence exist. A repeatable retrieval-quality evaluation and complete user-facing lifecycle proof remain required. |
| Operator dashboard for progress, approvals, history, cancellation, and recovery | Planned | No complete dashboard was demonstrated in the current repository baseline. |
| Android device adapters (contacts, notifications, intents, audio, background events) integrated through the canonical runtime | Planned | Must be delivered and tested as a governed adapter; do not infer it from the existence of a separate Android project. |
| External personal-workflow integrations (messaging, bookings, contacts across providers) | Planned | No end-to-end adapter set was demonstrated in this baseline. Each integration needs explicit permissions, offline/error behavior, and contract tests. |
| Release-grade install/upgrade/backup/restore/rollback workflow | Implemented but unverified end to end | README setup instructions and CI exist; a release-grade clean install, data migration, backup/restore, and rollback proof remains a release gate. |

## Current proof baseline

- Strict CI run #37982824901: 6/6 jobs succeeded; full-repository log reported 476 passed and 0 failed for that revision.
- Version consistency PR #128: package metadata is the version source; config and runtime read the shared version module. Strict CI run #37984907052 succeeded 6/6 jobs.
- Async execution status PR #130: unit/architecture tests for Node 20/22/24, PostgreSQL integration, static safety, and full repository suite passed in Strict CI run #37985452253 before merge.
- These results apply to those revisions and test cases; they are not a blanket claim that the product is complete or production-ready.

## Rule for changing a status

Every status change must cite the relevant source and tests, and distinguish a component-level test from an end-to-end product proof. If evidence is absent, keep the capability in the more conservative category.
