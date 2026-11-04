# ORIENT System Audit — 2026-11-04

## Audit identity

- Repository: `elsaadani40-pixel/Orient`
- Audited baseline: `main` at `1ac609e95a86356969e88f99786367d2c64324ce`
- Package version: `0.12.0`
- Runtime requirement: Node.js `>=22`
- Product status in repository: pre-release / active development
- Audit type: evidence-based architecture, integration, security-boundary, persistence, Android, and release-readiness baseline
- Scope limitation: this is a focused baseline over the composition root, runtime coordinators, memory/persistence path, HTTP routing, product/release contracts, Android manifest/docs, selected PRs/issues, and CI evidence. It is not a line-by-line audit of every file, a penetration test, or a physical-device acceptance run.

## Executive conclusion

ORIENT has a substantive governed-runtime foundation: one canonical runtime composition, capability registration and authorization, owner-session controls, durable execution/persistence adapters, approval decisions, recovery primitives, and a real Android client foundation.

It is not yet a complete cross-device personal AI operating system or a production internet service. The current release remains local-first and pre-release. Some product capabilities are deliberately disabled or incomplete, especially production asynchronous workers, provider-aware side-effect recovery, public multi-tenant Runtime access, multimodal chat, Android device adapters, and physical-device acceptance.

Do not replace the architecture or restart the project. Close integration and release gates in small independently verifiable changes.

## Evidence reviewed

- `package.json`, `README.md`, `app.js`
- `src/core/runtime/orient-runtime.js`
- `src/core/runtime/runtime-infrastructure-coordinator.js`
- `src/core/runtime/request-execution-coordinator.js`
- `src/application/memory/memory.service.js`
- `src/infrastructure/persistence/persistence-factory.js`
- `src/interfaces/http/server.js`, memory and agent route modules
- Cross-platform product contract, product contract, threat model, first-user acceptance and workbench checklists
- Android manifest, Gradle configuration, and Android README
- PRs #187, #188, #264, #265, #311, #312, #313, #314
- Issues #185, #189, #225, #263, #266

## Findings register

### OR-AUD-001 — Runtime startup readiness is not awaited on main

- Severity: P1
- Status: FIX IMPLEMENTED ON PR #312 HEAD; NOT YET ON MAIN
- Baseline evidence: `RuntimeInfrastructureCoordinator` starts `ensureTenant()` and `recoverPersisted()` from its constructor and stores promises in `quotaReady` / `recoveryReady`. The current `app.js` startup sequence awaits persistence initialization and access-audit initialization, then calls `server.listen()`; it does not await Runtime infrastructure readiness. The request execution coordinator does not await those readiness promises.
- Risk: with async persistence, early requests may race tenant quota initialization or persisted-workflow recovery.
- Existing remediation: PR #312 defers database-backed startup work to an idempotent `RuntimeInfrastructureCoordinator.initialize()`, exposes it through `OrientRuntime.initialize()`, and awaits it before HTTP listen.
- Evidence on proposed fix: PR #312 head `5b8ad27799f967146a77672e036d14c3813f0404` has successful Strict CI (6/6 jobs), Browser Acceptance, CodeQL, and Gitleaks runs. Its added runtime-infrastructure test proves constructor purity, initialization ordering, and idempotency.
- Acceptance: review complete PR diff; retain startup-order test; merge only after required review; verify the resulting main commit and its own checks.

### OR-AUD-002 — PostgreSQL mode does not use PostgreSQL for memory on main

- Severity: P1
- Status: FIX PROPOSED IN PR #312; NOT YET ON MAIN
- Baseline evidence: `app.js` selects the configured memory repository only when `persistenceMode === 'sqlite'`; every other mode, including PostgreSQL, falls back to `JsonMemoryRepository` and `MemoryAuditRepository`.
- Risk: task/execution persistence can use PostgreSQL while personal memory and memory audit remain file-backed, creating split durability/backup/restore and operational semantics.
- Existing remediation: PR #312 adds PostgreSQL memory and audit repositories and makes memory operations asynchronous under the selected database transaction boundary. It also updates memory tools, routes, and server dispatch to await those operations.
- Acceptance: verify JSON, SQLite, and PostgreSQL parity; transaction rollback; tenant isolation; restart recovery; audit consistency; and memory HTTP/tool behavior for all three modes. Run exact-head CI and integration tests after any rebase.

### OR-AUD-003 — Production asynchronous worker remains disabled

- Severity: P1 release/capability gate (intentional safety restriction, not a defect)
- Status: OPEN
- Evidence: current `app.js` explicitly leaves `stopWorkers` as a no-op and documents that production async workers remain disabled. Issues #185 and #189 prohibit production activation until the public task lifecycle and provider-aware idempotency/reconciliation are proven.
- Risk: queued asynchronous execution and automatic restart recovery must not be advertised as production behavior.
- Required work: prove public task API enqueue/idempotency replay through the real composition root; worker restart through approval and terminal completion; cancellation and shutdown/drain races; provider-side idempotency or authoritative reconciliation for each side-effect adapter. Unknown external outcomes must fail closed rather than replay blindly.
- Acceptance: all #185/#189 criteria tested against the actual production composition; exact-head Strict CI green.

### OR-AUD-004 — Android permission declaration conflicts with Android documentation

- Severity: P2 privacy / least-privilege issue
- Status: OPEN
- Evidence: `android/app/src/main/AndroidManifest.xml` declares `android.permission.READ_CONTACTS`, while `android/README.md` states the manifest grants only INTERNET and that no contacts permission is requested. The README also says device capability adapters remain disabled.
- Risk: declared permission surface and documented user expectations do not match.
- Required work: determine whether any current Android code genuinely needs contacts. If not, remove the permission. If it is required, document its exact user-visible use and request it only at the point of need. Add a manifest-level regression check.
- Acceptance: manifest and documentation agree; no unused sensitive permission; Android unit/build checks pass.

### OR-AUD-005 — Android is a local authenticated companion, not yet a cross-device agent

- Severity: P1 product-completion gate
- Status: PARTIAL / OPEN
- Evidence: Android README identifies owner login, task submission, and execution-history refresh against a service on the same device/loopback. Device capability adapters are disabled; no remote transport, offline outbox, contacts/call/notification/microphone integration, or emulator/device acceptance is claimed. The Gradle/CI gate proves build and unit tests only.
- Required work: versioned authenticated Runtime client; explicit offline/pending state and idempotent reconnect; permission-state and revocation handling for each adapter; emulator/instrumented smoke tests; physical-device evidence before claiming device readiness.
- Acceptance: a task created on one client is observed consistently on the other; offline/reconnect behavior is honest and idempotent; every device action is permission-gated and audited.

### OR-AUD-006 — Owner chat is not yet a multimodal assistant

- Severity: P1 product-completion gate
- Status: PARTIAL / OPEN
- Evidence: PR #264 and #265 deliver owner-authenticated task-backed chat and a chat workspace. Issue #266 records the remaining attachment pipeline and multimodal acceptance requirements. Text attachments are bounded; image, audio, PDF, and binary-document processing must not be advertised until end-to-end adapters and fixtures exist.
- Required work: maintain the structured final-answer/evidence/approval contract; add durable conversation retention/deletion semantics; implement bounded, content-sniffed attachment ingestion; add explicit local/optional model adapters for image/audio/document processing; fail truthfully when unsupported or offline.
- Acceptance: end-to-end fixtures for every claimed modality, malformed/oversized/MIME tests, owner/session isolation, deletion/retention tests, and no fabricated analysis.

### OR-AUD-007 — Public accounts are not proof of public multi-tenant Runtime isolation

- Severity: P1 security/product boundary
- Status: OPEN
- Evidence: issue #263 states Runtime routes are owner-session protected and that public-user cookies are denied access to owner Runtime APIs. It explicitly says this does not prove separate Runtime/persistence isolation per public account. External channels are not supported without provider authentication/signature verification.
- Risk: marketing or product behavior must not imply that ordinary public accounts have isolated personal agents or that WhatsApp/Telegram/voice providers are integrated.
- Required work: either keep Runtime owner-only and document it clearly, or design and test tenant-bound Runtime identities, authorization, persistence, quotas, approvals, and audit before exposing public Runtime access.
- Acceptance: cross-tenant denial and isolation tests across tasks, memory, events, approvals, idempotency, and tool execution.

### OR-AUD-008 — Public release and device acceptance remain blocked

- Severity: P1 release gate
- Status: OPEN
- Evidence: README and threat model explicitly describe a local development runtime, no public deployment URL, no independent external security review, and no public-hosting readiness. Issue #225 leaves manual browser acceptance on phone, tablet, and desktop, plus HTTPS/session/operations/security review, unchecked.
- Required work: complete first-user acceptance on actual environments; document deployment topology, HTTPS, durable session strategy, backup/restore, monitoring, incident response, retention, and external security review.
- Acceptance: redacted evidence attached to release candidate; external security findings triaged; no production-ready or secure certification claims before review.

### OR-AUD-009 — Several open PRs are based on older main snapshots

- Severity: P2 repository integration hygiene
- Status: OPEN
- Evidence: PR #312 targets the current audited main SHA. PR #187 and stacked draft PR #188 target an older base lineage; PR #313 and #314 also report a base SHA older than the audited main commit.
- Risk: stale diffs may reintroduce superseded files or conflict with recent merged memory work.
- Required work: rebase or close/replace stale stacks; inspect complete diffs after rebase; do not merge a PR solely because an earlier head passed CI.
- Acceptance: base SHA equals the intended current main lineage; mergeability, diff, review threads, and all checks verified on the final head.

## CI evidence and interpretation

- PR #311 head `097265aba632b4ef4b72a638c857d46c308c195e`: Strict CI, Browser Acceptance, CodeQL, and Secret Scanning reported successful. Its PR body records 733/733 unit + architecture tests on Node 22 and Node 24 and 799/799 full repository tests on Node 24 + PostgreSQL.
- PR #312 head `5b8ad27799f967146a77672e036d14c3813f0404`: Strict CI 6/6 jobs, Browser Acceptance, CodeQL, and Gitleaks reported successful. This is the exact PR head, not the main branch.
- These runs do not certify the current main merge commit, production deployment, physical Android behavior, or independent security review. Do not transfer CI status between SHAs.

## Recommended execution order

1. Complete the full review of PR #312, especially transaction boundaries, async service contracts, startup ordering, and all updated callers. Do not duplicate its changes on main.
2. Merge only after review and exact-head checks; then verify the resulting main SHA and rerun required checks.
3. Resolve the Android manifest/documentation permission mismatch with a narrow tested change.
4. Keep async worker activation blocked until #185 and #189 are fully proven.
5. Close the chat multimodal and Android cross-device gaps with real integration evidence.
6. Complete tenant isolation and public release/device acceptance gates before expanding deployment scope.

## Audit verdict

ORIENT is a serious pre-release engineering project with a coherent governed-runtime direction and substantial tested foundations. It is not yet a finished cross-platform personal AI operating system or a hardened public service. The next milestone should be integration correctness and release evidence, not adding more surface-area features.
