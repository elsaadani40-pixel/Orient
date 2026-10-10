# ORIENT Task Workbench

## Purpose and limits

The Arabic task workbench is served by the existing ORIENT HTTP server at `/workbench`. It is a browser client for the canonical v1 task API, not a separate runtime. It does not fabricate task records, infer completion from submission, bypass runtime authorization, or expose raw task results. The visible event list is the allowlisted summary returned by the API.

## Run locally

Requirements: Node.js 20+ and npm. From the repository root:

```bash
npm ci
npm test
npm run check:syntax
```

Set an owner password of at least 16 characters before starting the app. Keep this value local; do not commit it or send it to anyone.

Linux / macOS / Termux shell:

```bash
export ORIENT_OWNER_PASSWORD='replace-with-a-private-password-of-16-or-more-characters'
node app.js
```

On Windows PowerShell:

```powershell
$env:ORIENT_OWNER_PASSWORD = 'replace-with-a-private-password-of-16-or-more-characters'
node app.js
```

Open `http://127.0.0.1:8080/owner`, sign in, then open `http://127.0.0.1:8080/workbench` in the same browser. The app defaults to a loopback-only bind; this is intentional. Do not change the host binding or expose this development runtime to a public network just to test the page.

## Smoke test

1. Confirm an unauthenticated browser cannot load `/workbench` or `/api/v1/tasks`.
2. Sign in through `/owner` using the local owner password.
3. Open `/workbench`; the connection indicator should report the API result. An empty list is a valid state.
4. Submit a harmless, read-only goal, for example: `لخّص قدراتك المتاحة حاليًا وحدد بوضوح ما لا تستطيع تنفيذه من داخل هذا التشغيل.`
5. Select the returned task and refresh its status/events. Distinguish queued/running/approval-needed/failed/completed; a successful HTTP response only means the server accepted or returned the task.
6. Refresh the page and verify task history remains available from the server.
7. Sign out of `/owner` and verify the workbench and task API are denied after the session is cleared.

## Current behavior and known limits

- The task list uses bounded offset pagination because that is the current `GET /api/v1/tasks` contract; event history uses the event cursor contract.
- The page refreshes task summaries and the selected task periodically while visible.
- Detailed model output is intentionally not displayed because the v1 summary/event API does not promise that data.
- This PR adds a local workbench, not a hosted public deployment. Since the server binds to `127.0.0.1` by default, the URL is local to the device running ORIENT.
- Passing repository CI verifies automated scenarios, not a real-device/browser compatibility matrix or production readiness.
