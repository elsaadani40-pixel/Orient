# Owner, User Permissions, and Administration Gap Matrix

**Status:** repository-backed assessment and acceptance plan. This document does not claim that open pull requests are merged, browser acceptance is complete, or ORIENT is production-ready.

## Executive finding

ORIENT already has a meaningful security and control-plane foundation. The correct approach is incremental completion of existing work, not replacing the identity model or creating a second administration server.

Reviewed on the default branch at commit `5395d4b2a490a0eeebebbb50483e629b4bb11619` (2026-10-15):
- `src/interfaces/http/server.js`
- `src/interfaces/http/owner-dashboard.html`
- `src/interfaces/http/owner-dashboard.js`
- `docs/operations/DASHBOARD-CONTROL-PLANE.md`
- `docs/operations/TASK-WORKBENCH.md`
- `docs/security/THREAT-MODEL.md`
- `docs/product/ORIENT-PRODUCT-CONTRACT.md`

## Comparison matrix

| Enterprise control pattern | Evidence on current `main` | Existing work in open PRs (not merged) | Remaining acceptance / improvement |
|---|---|---|---|
| One authoritative owner identity across web and Runtime | Runtime-owned `/owner` and `/workbench` routes use owner authentication; threat model states public credentials are not owner credentials. | [#227](https://github.com/elsaadani40-pixel/Orient/pull/227) introduces a durable shared owner identity lifecycle; [#228](https://github.com/elsaadani40-pixel/Orient/pull/228) composes website and Runtime around shared identity. | Resolve dependencies and review exact combined head. Prove bootstrap, forced password rotation, old-session revocation, owner-only Runtime access, and denial of public-user sessions in integration tests. Do not merge a foundation PR alone. |
| Separate owner and public-user sessions | Threat model specifies separate identity paths and session revocation on account suspension. | [#219](https://github.com/elsaadani40-pixel/Orient/pull/219) includes account controls, suspension/session revocation, and regression tests; [#228](https://github.com/elsaadani40-pixel/Orient/pull/228) includes cross-surface identity checks. | Verify disabled accounts are denied on every protected route and existing sessions stop working immediately; verify reactivation does not revive old sessions. Check browser behavior, not only unit tests. |
| Server-side authorization on each operation | Runtime routes own operational endpoints; owner dashboard uses protected `/owner/audit` and `/owner/approvals`; state-changing requests attach CSRF token and same-origin checks are present in the server. | Account and unified-identity PRs add cross-surface tests. | Build/maintain a route-to-identity-to-permission table and regression-test direct HTTP calls, not only visible UI buttons. Every new admin endpoint must fail closed without a valid session and required CSRF protection. |
| Approval for high-risk actions | Dashboard describes tool/capability/step/expiry and requires explicit confirmation; canonical Runtime validates durable approval. | Existing workbench/project-builder PRs (#211/#221) preserve Runtime authorization and owner approval. | Test expired, reused, wrong-scope, and revoked approvals; verify cancelling browser confirmation sends no mutation request and an HTTP acceptance is not displayed as task completion. |
| Honest operational dashboard | Dashboard contract describes real task summaries, pending approvals, bounded durable event streams, and separates server reachability from renderer status. | [#243](https://github.com/elsaadani40-pixel/Orient/pull/243) adds owner-console Runtime connectivity and actual task count; its PR states exact-head CI and real-device check are pending. | Finish #243's dependency/CI review, then verify live connected, disconnected/error, and empty-task states in a real browser. Never use mock counts or infer a successful Runtime connection from page load. |
| Auditable access and decisions | Owner console currently displays access time, IP, route, method, HTTP status, authentication outcome, and duration; logs are intended to exclude credentials and raw sensitive bodies. | The current owner-console implementation includes the access audit view. | Define events for account status changes, role/policy changes, approval decisions, session revocation, and authentication failures. Apply retention and access controls; test redaction and avoid treating HTTP access logs as a complete business audit trail. |
| Roles and least privilege | Current documented model has an owner authority and separate public users; this does not itself establish a complete configurable RBAC system. | Open account-control PRs cover account lifecycle, not proof of a finished enterprise role/permission editor. | Do not add arbitrary roles until product requirements need them. First specify named roles, allowed actions, resource scope, and default-deny behavior; test cross-user task/memory/approval isolation. |
| Local-first security and deployment boundary | Dashboard contract says bind to loopback and fail closed for wildcard/remote hosts until remote authentication and transport protections are reviewed. Threat model explicitly says local development runtime, not hardened multi-user internet service. | No open PR cited here proves production deployment hardening. | Keep remote binding disabled until HTTPS, session security, persistence, rate limiting, operational monitoring, backup/recovery, and external security review are explicitly accepted. |

## Recommended admin information architecture (extend existing console)

1. **Overview:** actual Runtime connectivity, real task totals/status, and pending approvals.
2. **Users & accounts:** account state, suspend/reactivate, session revocation, and safe recovery flows.
3. **Permissions & policies:** initially display/audit the effective policy; allow only narrowly scoped, validated changes when a tested policy API exists.
4. **Tasks & Runtime:** actual task state and allowlisted events from canonical APIs.
5. **Approvals:** review exact capability, resource scope, expiry, and proposed effect before approval.
6. **Audit:** authentication, account lifecycle, permission/policy changes, approvals, and security-relevant outcomes.
7. **System settings:** safe, validated settings only; no arbitrary shell or model-driven privilege changes.

This is an information architecture for the existing owner console, not a proposal to build a second runtime or a second identity store.

## Merge and verification sequence

1. Review dependency order and exact heads for #227, #228, #219, and #243; avoid merging stacked PRs out of order.
2. Reconcile the owner identity/account-control changes against current `main`, preserving the current route ownership and canonical Runtime.
3. Run the repository's required Strict CI on the exact integrated head; do not infer current CI status from an older PR head.
4. Confirm integration tests for owner bootstrap/password rotation, session revocation, public-user denial, direct-route authorization, CSRF, account suspension/reactivation, and task/resource isolation.
5. Perform real-browser acceptance on phone and desktop for sign-in, password rotation, owner console, account controls, approvals, sign-out, and Runtime disconnected/error states.
6. Keep changes as drafts until all dependencies, CI, and browser acceptance are complete. Do not claim production readiness based on unit tests alone.

## Scope boundary

This assessment is based on repository files on `main` and the described scope/status of the linked open PRs as checked on 2026-10-15. Open PR code is not part of `main` until merged. This document is not a security certification and does not state that tests were run by this documentation change.
