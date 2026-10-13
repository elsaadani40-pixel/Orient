# ORIENT threat model (current implementation)

This is a working security note for the code that exists today, not a certification or a roadmap promise. Update it when a threat boundary or its tests change.

## Assets

- Owner credentials, session tokens, CSRF tokens, and account state.
- Public-user sessions and tenant-scoped tasks, memory, execution events, and approvals.
- Tool inputs, workspace files, command execution, model output, and audit records.
- Database credentials, local environment variables, and generated runtime state.

## Adversaries and attack paths

| Threat actor / input | What can go wrong | Current enforcement / evidence |
| --- | --- | --- |
| Unauthenticated remote or local HTTP caller | Read owner operations or forge state-changing requests | Local bind policy in `src/core/config/local-bind-policy.js`; owner session, same-origin and CSRF checks in `src/interfaces/http/server.js`; HTTP auth regression tests under `test/unit/interfaces/http/` |
| Ordinary registered user | Escalate a public session to owner or Runtime access | Separate public-user and owner identity paths; shared owner identity adapter; `test/unit/unified-owner-identity.integration.test.js` |
| Malicious prompt, model output, or project file | Cause unauthorized tool use, prompt injection, unsafe writes, or command execution | Tool capability registry, policy and authorization checks, plan validation, project-audit and high-risk recovery integration tests; OS sandbox setup is verified in Strict CI |
| Malicious or compromised dependency / leaked credential | Execute code in CI or expose tokens | `npm ci --ignore-scripts`, repository hygiene checks, Dependabot, CodeQL and Gitleaks workflows |
| Local OS user or process with access to the data directory | Read or replace owner state and user data | Owner state is written with restrictive file modes; this does **not** protect against a process running as the same OS user or a compromised host |

## Security invariants

1. Public-user credentials are never accepted as an owner session.
2. Owner-changing requests require same-origin validation and a session-bound CSRF token.
3. Owner password rotation invalidates previous owner sessions; public-account suspension revokes its sessions.
4. Sensitive tool execution must pass capability and authorization enforcement. Do not invoke an arbitrary shell command directly from a request or model response.
5. The local server must not bind to wildcard or remote addresses by default. A public deployment requires a separately reviewed HTTPS, authentication, persistence, and operational boundary.
6. Audit records must not contain passwords, cookies, CSRF tokens, or raw sensitive request bodies.

## Known limitations / acceptance gates

- The default application is a local development runtime, not a hardened multi-user internet service.
- The sandbox guarantee applies only when the OS isolation backend and its resource controls are actually available and enabled. CI verifies the Linux Bubblewrap/AppArmor/systemd environment; a successful unit test on a host without those controls is not proof of OS isolation.
- CodeQL and secret scanning identify classes of issues; neither replaces dependency review, manual authorization review, penetration testing, or external security assessment.
- No independent external security review has been completed. Do not describe ORIENT as “secure” or production-ready on the basis of these controls alone.

## Required change discipline

For a security-boundary change, update or add a test that fails if the boundary is removed. Keep this file limited to current threats and evidence; implementation and tests remain the source of truth.
