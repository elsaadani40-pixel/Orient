# ORIENT ONE Owner Console

## Local setup

The owner console has no default password. Configure `ORIENT_OWNER_PASSWORD` in the same shell that starts ORIENT ONE. The password must contain at least 16 characters. Do not commit it, put it in source files, or send it in chat.

In Bash/Termux, enter it without echoing it or placing it in shell history:

```bash
read -rsp "ORIENT ONE owner password: " ORIENT_OWNER_PASSWORD
printf '\n'
export ORIENT_OWNER_PASSWORD
npm start
```

Open `http://127.0.0.1:8080/owner` (change the port if `PORT` is configured). After login, use **لوحة التشغيل** to access the operational dashboard. The same owner session protects the dashboard and its HTTP API. If the password is absent or too weak, authentication fails closed rather than using a default credential.

## Session and request protections

- Session tokens are random, opaque, and stored server-side as SHA-256 digests.
- The browser cookie is `HttpOnly`, `SameSite=Strict`, scoped to `Path=/`, and expires after 30 minutes. A `Secure` attribute is added when the server socket is HTTPS.
- Login/logout enforce same-origin checks; logout also requires the session CSRF token.
- Operational HTTP routes require an authenticated owner session when the production composition is used. Mutating browser requests from a different origin are rejected.
- At most 64 active sessions are allowed by default; expired sessions are pruned before new login and during authentication. Sessions and login-failure counters are currently in memory. Restarting the process invalidates active sessions and resets the rate-limit counters.

## Access audit scope

The owner console shows recent requests that pass through ORIENT ONE's HTTP server and lists pending high-risk approvals. Approval resumes the matching execution using its scoped approval ID; cancellation is a separate explicit action. Both actions require the owner session, same-origin validation, and CSRF token. The log records the direct socket IP, a route template, method, status, bounded user-agent, timing, request ID, and authentication outcome. It deliberately excludes query strings, request bodies, passwords, cookies, and authorization headers. The JSONL log is hash chained and rotated at 5 MiB per file with three retained archives (about 20 MiB maximum for the active file plus archives). Integrity is re-checked across retained segments before showing the log. When retention removes the oldest segment, the oldest remaining record becomes the verification anchor; older deleted records are no longer available for verification.

This is application-level HTTP auditing, not device-wide monitoring. It cannot observe activity outside ORIENT ONE, and the current server is intentionally loopback-bound. It therefore does not yet provide a secure multi-device/LAN deployment or record remote client IPs. Audit retention/rotation and durable session storage remain follow-up work.
