# Owner Control Plane Threat Model

**Status:** Design baseline; implementation not yet complete  
**Scope:** ORIENT ONE owner console, HTTP access boundary, Android companion, tool execution, access/audit events  
**Date:** 2026-10-10

## Security objectives

1. Only the authenticated owner can use owner-administration functions.
2. Ordinary clients cannot grant capabilities, approve their own high-risk actions, read another tenant's records, or change security policy.
3. Every operation executed through ORIENT ONE has a traceable, privacy-minimized audit trail.
4. The central Runtime and authorization boundary remain authoritative; the dashboard is never a bypass.
5. Android capabilities remain bounded by OS permissions, user-visible consent, and supported platform APIs.
6. Secrets and private task content are not copied into security logs.
7. Failures deny access safely and leave a useful, redacted security record where persistence is available.

## Assets

- Owner credentials, password verifiers, session identifiers, CSRF tokens, signing keys.
- Tenant/workspace identity and capability grants.
- Execution summaries, approval records, policy decisions, audit events.
- Android contacts, call-state metadata, notifications, files, microphone/audio access, and device events when the user grants the relevant permission.
- Database credentials and local runtime data.

## Trust boundaries

1. **Untrusted HTTP client → local HTTP interface.** Existing loopback-only binding remains mandatory until authentication and transport protections are implemented and verified.
2. **Normal dashboard → owner control plane.** Distinct routes, session audience, authorization checks, and UI; hiding controls is not authorization.
3. **Model/planner → tool registry.** Model output is untrusted input. Only registered, schema-validated tools can be invoked.
4. **Tool → external system/device.** Each adapter applies least privilege, bounded input/output, timeouts, and explicit confirmation for consequential actions.
5. **Android app → OS APIs.** Runtime permissions, permission revocation, background-execution restrictions, and platform policy are authoritative.
6. **Application → persistence/audit log.** Audit writes must not leak secrets and must be scoped to the correct tenant; log-read access is itself audited.

## Threats and required controls

| Threat | Required control | Verification evidence |
|---|---|---|
| Credential guessing / brute force | Rate limits, bounded exponential backoff or temporary lockout, generic auth errors | Repeated-failure integration tests |
| Session theft / fixation | High-entropy opaque sessions, server-side expiry/revocation, rotate on login, HttpOnly + SameSite cookies; Secure in HTTPS deployments | Cookie and lifecycle tests |
| CSRF against owner actions | SameSite policy plus explicit CSRF defense and origin checks for state-changing browser requests | Cross-origin negative tests |
| Cross-tenant or normal-user privilege escalation | Server-side owner role checks on every owner route and tenant checks on every record lookup | Allow/deny matrix and tenant-isolation tests |
| Secret leakage in logs | Allowlisted event schema; redact credentials, cookies, authorization headers, tokens, raw prompts and file contents | Adversarial redaction tests |
| Spoofed client IP | Treat forwarded headers as untrusted unless a configured trusted proxy is explicitly used | Proxy-header spoofing tests |
| Log tampering / denial | Append-only repository API, sequence/previous-hash linkage where supported, bounded retention and monitored persistence failures | Restart, integrity and failure tests |
| Unauthorized capability execution | Existing runtime authorization, risk classification, approval and execution-time validation remain mandatory | Runtime-level denial tests |
| Malicious prompt/file/tool output | Schema validation, content treated as untrusted data, sandbox/resource limits, output redaction | Injection and boundary tests |
| Android permission bypass / hidden capture | OS permission APIs, visible rationale, revocation handling; no covert recording or permission bypass | Android permission-state tests and manual review |
| Overcollection of IP/device data | Collect only access/security metadata needed for security and abuse prevention; documented retention/deletion | Schema review and retention tests |
| Denial of service via requests/events | Body and field limits, bounded pagination, request timeouts/rate limits, bounded audit queue | Load and limit tests |

## IP and access-event data contract

An access event may include:
- UTC timestamp and server-generated request/correlation ID.
- Source IP observed by the server, normalized and stored as security metadata.
- Authentication outcome and a stable reason code, not raw exception text.
- Route template and HTTP method, not arbitrary query strings.
- Coarse user-agent/client label only if operationally useful.
- Authenticated owner/user/tenant identifier where known.
- Execution/action identifier and policy outcome when an action is requested.
- Integrity sequence or hash linkage where the selected repository supports it.

Never store passwords, password input, session cookies, authorization headers, bearer tokens, CSRF tokens, raw microphone/audio content, full contact lists, raw task prompts/results, or arbitrary request bodies in the access log. Do not trust `X-Forwarded-For` or similar headers unless the deployment explicitly configures and validates a trusted reverse proxy. IP addresses are not proof of identity and may be personal data.

## Owner access model

- A single-owner deployment begins with one explicitly provisioned owner; no public self-registration or default password.
- Password verifiers use a modern password-hashing function with per-user salt and safe parameters. Never store plaintext or reversible passwords.
- Owner sessions are random, opaque, revocable, server-side, expiry-bounded, and not placed in localStorage.
- Owner routes require authentication and authorization independently of frontend visibility.
- High-impact controls require confirmation and, where relevant, the existing runtime approval flow.
- Recovery must be documented; avoid insecure backdoors and hard-coded reset secrets.
- Keep remote/LAN bind disabled until authentication, session protections, CSRF protections, rate limiting, and HTTPS/transport requirements are tested together.

## Privacy, retention, and access to logs

- Provide a clear notice that access and in-project actions are security-audited.
- Restrict audit-log reads to the owner; audit these reads without recursively logging full log contents.
- Define configurable retention and deletion/rotation before production use. Keep only data required for security and operational accountability.
- Use least-privilege database access and protect backups. Encryption at rest depends on the deployment/storage layer and must not be claimed unless configured and verified.
- Audit logs must not be used to silently monitor unrelated device activity.

## Rollout gates

Remote access must remain disabled until all of these are true:
1. Owner authentication and session lifecycle implemented.
2. Server-side owner authorization covers every owner route and state-changing request.
3. CSRF and origin defenses verified.
4. Rate limits and brute-force controls verified.
5. Durable access/action audit repository tested across restart and tenant boundaries.
6. Secret redaction, retention, and log-access controls tested.
7. Android permission flow and revocation behavior reviewed.
8. Exact-head CI is green and the route matrix is reviewed.

## Current known gaps

This document is a threat model, not an implementation claim. The current repository has a local-only HTTP bind policy and a shared local operations dashboard. It does not yet provide the separate authenticated owner console described here. Do not enable remote access or call the system production-ready until the rollout gates are met.
