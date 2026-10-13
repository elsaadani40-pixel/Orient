# ORIENT Cross-Platform Product and Release Contract

Status: required architecture contract; acceptance evidence must be attached to the change that implements each capability.

## Product invariant

ORIENT is one product delivered through web, Android, and other clients. The website, Android app, and Runtime are not independent products and must not develop conflicting task, identity, memory, authorization, or execution semantics.

The canonical Runtime and its policy/authorization boundary own task planning and execution. Clients may present state, collect input, cache explicitly cacheable data, and request actions through versioned interfaces; they must not create alternate execution authorities or claim work completed without canonical evidence.

## Sources of truth

- **Runtime:** canonical task/workflow state, execution results, approvals, authorization decisions, and audit events.
- **Owner identity:** one durable owner identity/session authority shared by website and Runtime adapters. Public-user sessions remain separate and can never authenticate as owner.
- **Public API contract:** versioned request/response schemas, stable error codes, authorization requirements, and compatibility rules. Web and Android consume the same contract rather than reimplementing business rules.
- **Client-local storage:** a cache/outbox only. Local/offline state must be marked as pending or unverified until the Runtime confirms it. Client storage is not a second canonical execution history.
- **Repository release state:** one commit/release identifies the compatible Runtime, website, API contract, and Android build. A platform is not “complete” if its required integration is absent.

## Change workflow

For every feature touching tasks, identity, memory, permissions, approvals, synchronization, or execution:

1. State the behavior and threat/failure cases before implementation.
2. Identify affected Runtime, website, Android, persistence, and API-contract surfaces in the pull request.
3. Implement the canonical behavior once in the Runtime/application layer; keep transport-specific adapters thin.
4. Add contract tests plus integration tests for allowed and denied paths, stale sessions, retries/idempotency, and offline/reconnect behavior where relevant.
5. Run Strict CI, including Node matrix, PostgreSQL integration, and Android unit tests/build. Do not report success without the actual run for the exact commit.
6. Where browser/device behavior is part of acceptance, record browser or physical/emulated device evidence separately; a successful compile is not UI acceptance.
7. Merge only when all required gates are green and the PR lists any explicitly deferred surface. Do not silently ship a feature on only one client.

## Cross-surface acceptance checklist

- [ ] One canonical API/schema and stable error behavior are used by website and Android.
- [ ] Authentication and authorization are enforced by the server; hiding UI controls is not authorization.
- [ ] Owner authority is never inferred from a public-user cookie or client-supplied role.
- [ ] Task creation, status, cancellation, approvals, and execution results converge on the same Runtime record.
- [ ] Offline actions are queued visibly and idempotently; no client fabricates server-confirmed success.
- [ ] Version/compatibility behavior is explicit for older clients.
- [ ] Strict CI is green for the exact head commit.
- [ ] Browser/device acceptance evidence exists for the changed user journey.
- [ ] Release notes identify the commit and the platform surfaces included.

## Current integration boundary

The owner identity lifecycle work in PR #227 is an initial service slice, not proof of a unified server. It must not be merged or deployed until website and Runtime adapters share the same instance, route ownership is explicit, and cross-surface tests prove bootstrap, forced password rotation, owner-only Runtime access, public-user denial, and session revocation.

The Android companion currently has a build/test gate in Strict CI. That gate proves compilation and unit tests only; it does not by itself prove that the installed app uses the same deployed Runtime or that end-to-end account/task synchronization works.

## Honest status vocabulary

Use **implemented** only when code exists; **unit-tested** only when relevant tests pass; **integration-verified** only when cross-component tests pass; **browser/device-verified** only with recorded runtime evidence; and **released** only when the identified build is actually available to users. Never substitute a green build for a stronger status.
