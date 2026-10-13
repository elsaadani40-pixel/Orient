# ORIENT Task Workbench

## Purpose and limits

The Arabic task workbench is served by the canonical ORIENT HTTP server at `/workbench`. It is a browser client for the versioned Runtime task API, not a second execution engine. It does not fabricate task records, infer completion from submission, bypass runtime authorization, or expose raw task results. Task state and events come from the server.

Project presets include read-only audit, proposal-only analysis, and owner-approved project changes. Selecting a preset only fills the form; the owner must review the goal and explicitly submit it. High-risk writes remain subject to the Runtime's capability authorization and durable owner approval.

## Run locally

Requirements: Node.js 22 or newer and npm. From the repository root:

```bash
npm ci
npm test
npm run check:syntax
```

On a first run, configure `ORIENT_OWNER_BOOTSTRAP_PASSWORD` with a unique password of at least 14 characters. `ORIENT_OWNER_PASSWORD` is accepted as a compatibility alias. Keep the value local; never commit it or send it to anyone.

Linux / macOS / Termux shell:

```bash
export ORIENT_OWNER_BOOTSTRAP_PASSWORD='choose-your-own-local-bootstrap-password'
npm start
```

On Windows PowerShell:

```powershell
$env:ORIENT_OWNER_BOOTSTRAP_PASSWORD = 'choose-your-own-local-bootstrap-password'
npm start
```

Open `http://127.0.0.1:8080/owner`, sign in as Admin, and complete the mandatory first-run password rotation if prompted. Then open `http://127.0.0.1:8080/workbench` in the same browser. The server binds to loopback by default; do not expose this development runtime to a public network.

## Smoke test

1. Open `/workbench` without an owner session. The server should redirect to owner sign-in.
2. Sign in and complete any required password rotation. Reopen `/workbench`.
3. Confirm the connection indicator reports the real API response. An empty task list is valid; fabricated task rows are not.
4. Submit a harmless, read-only goal, for example: `لخّص قدراتك المتاحة حاليًا وحدد بوضوح ما لا تستطيع تنفيذه من داخل هذا التشغيل.`
5. Try the read-only project audit preset. Verify that selecting it only fills the form and does not submit it.
6. Try the proposal-only preset and confirm the generated plan contains no execution step.
7. For a project write, inspect the proposal and confirm that execution pauses until the owner explicitly approves the high-risk action. Do not use destructive goals during acceptance.
8. Select the returned task and refresh its status/events. Distinguish queued, running, awaiting-approval, failed, cancelled, and completed. A successful HTTP response only means the server accepted or returned the task.
9. Sign out of the owner console and verify the workbench and task APIs are denied after the session is cleared.
10. Repeat on a narrow phone viewport and on a desktop browser. Record browser/device evidence separately from CI results.

## Current behavior and known limits

- Task submission uses the canonical v1 API with an idempotency key. An uncertain network result must not create a second task when retried with the same key.
- The page displays bounded task summaries and allowlisted events; it does not promise full model output.
- Project audit and proposal tools are read-only. Project execution is a separate high-risk tool behind Runtime authorization and durable owner approval.
- Test commands are disabled unless explicitly enabled by the outer project policy. A write must not silently grant itself permission to run project-controlled code.
- Matching file contents alone are not proof that a particular operation applied them; recovery fails closed when a durable operation receipt is missing.
- This is a local workbench, not a claim that a hosted public deployment is live. Passing CI does not prove real-browser/device compatibility or production readiness.
