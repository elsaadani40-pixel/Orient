# ORIENT Android Real-Device Acceptance and Release Gate

**Status: NOT YET ACCEPTED ON A PHYSICAL DEVICE. Do not describe this build as field-tested or production-ready.**

This document separates repository/CI evidence from physical-device evidence. A green Android build or Robolectric test is not proof that the APK launches and works on a real phone.

## Candidate build identity

- Repository: `elsaadani40-pixel/Orient`
- Integrated source commit: `4487394e4dbfbbc27a98107ff3f08d7aaac6c993`
- Android source tree was built by Strict CI for PR head `2431c78fa95c19580adfc19acc8cc65c962ea2a0`, whose changes were merged by squash.
- CI run: [Strict CI #2163](https://github.com/elsaadani40-pixel/Orient/actions/runs/38656583096)
- CI Android job: **Android Companion (Gradle 9.6 / JDK 17)** — passed.
- Artifact: `orient-one-android-debug-apk`, 11,240,178 bytes, SHA-256 digest reported by GitHub for the artifact archive: `57544bebc26b28c4dca385f5acc9d43e10d9e3c599a1434a3b27418937bc6dc9`.
- Artifact archive expires **2026-10-21**. Download it from the linked Actions run's **Artifacts** section. The archive digest identifies the ZIP artifact, not the APK file inside it.
- This is a **debug candidate**, not a signed production release. Do not distribute it as a stable public release.

## Preconditions and safety

- Use a real Android phone running Android 8.0/API 26 or newer.
- The Android companion currently connects only to `127.0.0.1`; ORIENT Runtime must run on the **same phone**, for example in Termux. It is not currently a remote-phone client.
- Keep the server bound to loopback. Do not expose the development server to the LAN or internet to make this test pass.
- Never paste owner passwords, cookies, session tokens, private logs, or personal data into an issue/PR. Use a throwaway test task with no destructive side effects.
- Record Android version, device model, APK SHA-256, test date/time, and pass/fail outcomes. Redact serial numbers, IMEI, phone numbers, and account details from screenshots.

## Prepare the phone

1. Install/update Termux from a trusted source and open it.
2. Obtain the exact repository commit under test in Termux, then run `npm ci`. Use Node.js 22 or 24, consistent with CI.
3. On a first local bootstrap only, set `ORIENT_OWNER_BOOTSTRAP_PASSWORD` to a unique strong local password (at least 14 characters) and start the server with `npm start`. Keep that value only in the local Termux shell; do not commit it or send it in chat.
4. Confirm the server responds locally at `http://127.0.0.1:8080` and complete the owner setup/password-rotation flow in the local browser if required.
5. Download `orient-one-android-debug-apk` from the Actions run above, extract the APK, and calculate the APK file's own SHA-256 locally (for example, `sha256sum app-debug.apk`). Record that value; do not substitute the ZIP digest above.
6. Install the APK using Android's package installer. If Android asks permission to install from that source, grant it only for the trusted download flow and revoke it afterward if appropriate.

## Required physical-device test cases

Record each as **PASS**, **FAIL**, or **BLOCKED**. A screenshot alone is insufficient for an authorization or persistence test; record the observed result without secrets.

| ID | Test | Pass criteria | Result |
|---|---|---|---|
| D1 | Cold launch | App launches on the physical phone without crashing; Arabic text is legible and controls are usable. | BLOCKED — not yet run |
| D2 | Wrong owner password | Authentication is denied; app does not display authenticated state or task data. | BLOCKED — not yet run |
| D3 | Valid owner login | App authenticates against the same-phone Runtime on port 8080 and shows a server-backed response. | BLOCKED — not yet run |
| D4 | Harmless task | Submit a read-only request; UI distinguishes sending/waiting from a returned Runtime response. Do not count HTTP acceptance alone as task completion. | BLOCKED — not yet run |
| D5 | Refresh task list | Tap “تحديث قائمة المهام”; result comes from the server API, not fabricated local rows. | BLOCKED — not yet run |
| D6 | Runtime unavailable | Stop the local server, attempt a refresh, and confirm the app reports a connection failure without claiming success; restart the server afterward. | BLOCKED — not yet run |
| D7 | Logout | Tap “تسجيل الخروج”; local authenticated UI and displayed result clear, and a protected request cannot reuse the cleared client session. | BLOCKED — not yet run |
| D8 | Process restart | Force-stop and reopen the app. Confirm it does not silently restore an owner session from disk; sign in again. | BLOCKED — not yet run |
| D9 | Small-screen/keyboard | Keyboard does not permanently hide task submission, text fields remain editable, and vertical scrolling works. | BLOCKED — not yet run |
| D10 | Repeat launch | Close/reopen the app at least three times and check for crash, stuck loading state, or false “connected” status. | BLOCKED — not yet run |

## Evidence record — fill only after the device run

- Tester:
- Test date/time and timezone:
- Device model:
- Android version/API:
- APK SHA-256:
- Runtime source commit:
- D1–D10 results (attach concise notes):
- Blocking defects/issues:
- Redacted screenshots or screen recording:
- Final device acceptance decision: **NOT ACCEPTED until all required cases pass or each exception is explicitly approved and documented.**

## Release decision

The linked CI run passed the Android build/tests, Node 22/24 suites, PostgreSQL integration, static safety checks, CodeQL, and secret scanning for the PR head. These are automated evidence only. The release remains **blocked on physical-device acceptance** because no attached device session or independently supplied device evidence is available to this workflow.

After physical acceptance, rerun/check all required gates against the exact release commit, generate and verify the release artifact from that exact commit, record the artifact checksum, and publish release notes that state the tested device/Android version and known limitations. Do not call a debug APK a production release.
