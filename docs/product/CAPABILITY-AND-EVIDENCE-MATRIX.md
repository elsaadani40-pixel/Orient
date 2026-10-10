# ORIENT Capability and Evidence Matrix

This matrix deliberately separates repository evidence from product intent. "Present" means the capability is described in the current product contract or known project baseline; it does **not** by itself prove that every route, client, permission boundary, or end-to-end path passes acceptance tests. Do not change a row to Released without linking code and test evidence.

| Capability | Current classification | Evidence required before release | Next implementation action |
|---|---|---|---|
| Canonical Node.js runtime | Present; implementation exists | Runtime entry point, service wiring, integration tests | Map each task API handler to the canonical runtime and policy services |
| Capability authorization and risk policy | Present in core architecture; exact endpoint integration must be audited | Deny-by-default tests, unregistered capability tests, high-risk approval tests | Verify all client-originated execution paths cross the same gate |
| Durable task state and recovery | Partial / requires end-to-end proof | Restart/resume, idempotency, cancellation, timeout, event-sequence tests | Map existing persistence and recovery services to canonical task lifecycle |
| Android companion client | Partial | Build, emulator/device checks, session expiry/offline behavior, actual runtime integration | Replace or wrap any feature-specific flows with shared task API |
| Android task creation/history | Reported in product contract; handler-level mapping unverified here | Authenticated integration tests and cross-user isolation | Trace API calls to handlers and runtime services |
| Responsive web client | Not verified as a complete shared-task client | Browser E2E at mobile, tablet, and desktop widths | Implement after server task contract and route mapping |
| Capability discovery API | Not verified | Contract tests prove only registered/enabled capabilities are returned | Expose registry metadata without duplicating runtime policy |
| Unified plan/status/approval/event API | Not verified end-to-end | API contract, tenant isolation, stale approval, event cursor/gap tests | Implement on existing task/runtime services |
| Read-only workspace search/read | Not verified as a registered governed capability | Path traversal/symlink, output limits, scope, privacy and E2E tests | Add least-privilege read-only capabilities first |
| Governed file edits with diff/rollback | Planned; do not advertise as available | Path confinement, diff preview, backup, approval, atomicity, rollback and post-write verification | Design only after read-only capabilities are proven |
| Research-to-plan-to-verify orchestration | Partial/planned as a complete user workflow | Source provenance, bounded plan, preflight, real postcondition verification, recovery E2E | Connect existing planner/runtime/recovery services; never fake unavailable research |
| Validated procedural learning | Planned as a product-level acceptance gate | Provenance, repeatable tests, versioning, stale detection and rollback | Promote only test-proven procedures; failed attempts remain untrusted |
| Cross-device synchronization | Not verified | Conflict tests, explicit sync state, authorization, offline queue and restore tests | Define persistence and conflict semantics before enabling sync |
| Physical Android device validation | Not verified by CI alone | Dated device/model/OS test record and reproducible acceptance steps | Keep physical-device evidence separate from build/emulator status |

## Evidence rules

- CI green is evidence only for the jobs and assertions that ran.
- Android compilation does not prove runtime permissions or physical-device behavior.
- A route returning HTTP success does not prove task completion; acceptance checks and postconditions must pass.
- A mock-only test does not prove integration with the canonical runtime.
- Documentation and roadmap items are not implementation.
- Unknown/unverified is not equivalent to failed, but must not be presented as released.

## Release gate template

For each capability, record: code paths; schema/version; authorization owner; data scope; supported platforms; unit/contract/integration tests; CI run URL and exact job results; emulator/browser viewport evidence; physical-device evidence where relevant; known limitations; rollback/recovery behavior; release decision and reviewer.
