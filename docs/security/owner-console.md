# ORIENT ONE Owner Console

## Local setup

The owner console has no default password. In the unified application, configure `ORIENT_OWNER_EMAIL` and `ORIENT_OWNER_BOOTSTRAP_PASSWORD` in the protected environment before first start. The bootstrap password must be exactly 10 ASCII digits and is used only for the first owner sign-in. After sign-in, change it to a permanent password of at least 14 characters from the shared account workspace. Never commit either value, put them in source files, or send them in chat.

For local first-run setup, load the bootstrap value from a protected local secret store or enter it into the shell without echoing it or placing it in shell history. Do not add it to a checked-in `.env` file. Production deployments must use the platform's encrypted environment settings.

```bash
read -rsp "ORIENT bootstrap password (10 digits): " ORIENT_OWNER_BOOTSTRAP_PASSWORD
printf '\n'
export ORIENT_OWNER_BOOTSTRAP_PASSWORD
export ORIENT_OWNER_EMAIL="elsaadani40@gmail.com"
npm start
```

After the first successful sign-in and password rotation, remove the bootstrap variable from the shell/deployment configuration; changing it later does not reset an initialized owner identity.

Open `http://127.0.0.1:8080/owner` (change the port if `PORT` is configured). After login, use **لوحة التشغيل** to access the operational dashboard. The same owner session protects the dashboard and its HTTP API. If the password is absent or too weak, authentication fails closed rather than using a default credential.

## Session and request protections

- Session tokens are random, opaque, and stored server-side as SHA-256 digests.
- The browser cookie is `HttpOnly`, `SameSite=Strict`, scoped to `Path=/`, and expires according to the server-issued owner session TTL. The Android loopback client uses the same owner identity/session authority and keeps its cookie and CSRF token in memory only. A `Secure` attribute is added when the server socket is HTTPS.
- Login/logout enforce same-origin checks; logout also requires the session CSRF token.
- Operational HTTP routes require an authenticated owner session when the production composition is used. Mutating browser requests from a different origin are rejected.
- At most 64 active sessions are allowed by default; expired sessions are pruned before new login and during authentication. Session digests, CSRF values, expirations, and bounded per-IP login-failure/lockout state are persisted in `data/agent/owner-auth-state.json` using atomic replacement and restrictive file/directory permissions where supported. Raw session bearer tokens are never persisted. Corrupt or unsupported state fails startup closed rather than silently discarding lockouts or revocations. Back up this file only as sensitive security state; protect the host and filesystem, because a local administrator or process with the same OS privileges can still read or replace it.

## Access audit scope

The owner console shows recent requests that pass through ORIENT ONE's HTTP server and lists pending high-risk approvals. Approval resumes the matching execution using its scoped approval ID; cancellation is a separate explicit action. Both actions require the owner session, same-origin validation, and CSRF token. The log records the direct socket IP, a route template, method, status, bounded user-agent, timing, request ID, and authentication outcome. It deliberately excludes query strings, request bodies, passwords, cookies, and authorization headers. The JSONL log is hash chained and rotated at 5 MiB per file with three retained archives (about 20 MiB maximum for the active file plus archives). Integrity is re-checked across retained segments before showing the log. When retention removes the oldest segment, the oldest remaining record becomes the verification anchor; older deleted records are no longer available for verification.

This is application-level HTTP auditing, not device-wide monitoring. It cannot observe activity outside ORIENT ONE, and the current server is intentionally loopback-bound. It therefore does not yet provide a secure multi-device/LAN deployment or record remote client IPs. Audit retention/rotation is implemented for bounded JSONL segments; secure multi-device/LAN access remains intentionally disabled until a separately reviewed transport and identity boundary is implemented.
