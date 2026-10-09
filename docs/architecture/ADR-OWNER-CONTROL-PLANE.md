# ADR: Separate Owner Control Plane and Governed Android Capabilities

- **Status:** Accepted design direction; implementation pending
- **Date:** 2026-10-10
- **Decision owners:** ORIENT ONE project maintainer

## Context

The current local dashboard is an operations view, not a separate authenticated owner console. The HTTP server deliberately binds only to loopback because a complete remote authentication/session boundary is not implemented. ORIENT ONE also needs an Android adapter, stronger access auditing, and a growing catalog of search, read/write/edit, communication, and device capabilities.

Adding controls directly to the existing dashboard or letting the model invoke device and filesystem operations would blur trust boundaries and risk bypassing the canonical runtime.

## Decision

1. Keep the existing dashboard as an operational view; introduce a separate owner control plane with distinct routes, authentication/session handling, and server-side owner authorization.
2. Preserve the canonical Runtime, tool registry, capability policy, authorization service, risk classification, human approval, persistence, and recovery paths as the only route to execution.
3. Implement access and action audit as a typed, privacy-minimized durable subsystem; log actions performed through ORIENT ONE, not unrelated activity outside it.
4. Build Android as a Kotlin adapter/client over a versioned, authenticated interface. Keep Android-specific APIs out of the core runtime.
5. Register each tool with a schema, capability identifier, risk tier, timeout/resource limits, permission requirements, audit behavior, and verification strategy.
6. Keep HTTP bound to loopback until the complete authentication, session, CSRF, rate-limit, and transport boundary is implemented and tested.
7. Prefer built-in and open-source components, avoid mandatory paid APIs, and do not add dependencies without a concrete capability and maintenance rationale.

## Consequences

### Positive
- Owner controls are not conflated with normal operations.
- The runtime remains the policy enforcement point.
- Android platform permission handling is isolated from platform-neutral orchestration.
- Access history can be audited without turning logs into a copy of private task content.
- New capabilities can be reviewed against one registration and test contract.

### Costs
- Authentication/session lifecycle, durable audit storage, route isolation, and Android permission flows require separate tests and integration work.
- Remote use stays unavailable until the security rollout gates pass.
- The first Android milestone may provide a secure adapter foundation before all device capabilities are implemented.

## Capability contract

Every new tool/adapter must declare:
- Stable tool/capability ID and version.
- Input/output schema and size limits.
- Required OS/app permissions.
- Risk tier and approval rule.
- Timeout, cancellation, and resource limits.
- Data classification and redaction policy.
- Audit event fields and retention expectations.
- Postcondition/result verification and failure semantics.
- Unit and integration tests for allowed, denied, revoked, malformed, timeout, and recovery cases.

## Explicit non-goals

- No hidden monitoring of a person's unrelated device activity.
- No secret microphone/call recording or permission bypass.
- No unrestricted model-generated shell, filesystem, network, or device execution.
- No hard-coded default owner password, embedded secrets, or unauthenticated remote administration.
- No claim of production readiness based solely on green unit tests.
