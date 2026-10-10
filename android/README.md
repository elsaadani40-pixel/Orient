# ORIENT ONE Android Companion

**Status: authenticated local runtime client implemented; device capability adapters remain disabled.**

This Kotlin/Jetpack Compose app connects to an ORIENT ONE service running on the same Android device, typically from Termux. It supports owner login, task submission through the canonical runtime, and execution-history refresh. It does not pretend that unimplemented search, file, phone, contact, notification, or microphone tools are available.

## Toolchain

- Android Gradle Plugin 9.4.0
- Gradle 9.6.0
- Kotlin 2.4.10 and Compose compiler plugin
- Compose BOM 2026.08.00
- minSdk 26; targetSdk 36; compileSdk 37
- Java 17 for the build

## Build and test

From the repository root, use an installed Gradle 9.6.0 and Android SDK with API 37:

```sh
gradle --no-daemon -p android testDebugUnitTest assembleDebug
```

The GitHub Actions workflow `.github/workflows/strict-ci.yml` runs Android unit tests and assembles a debug APK.

## Connect locally

See [the owner console security guide](../docs/security/owner-console.md). Start the Node service with `ORIENT_OWNER_PASSWORD` configured, then enter that same password and the service port (default `8080`) in the Android app. The client only connects to `127.0.0.1`; it does not accept remote hosts. Password, session cookie, and CSRF token are kept in memory only. Reopen the app and sign in again after process restart.

The manifest grants only `INTERNET`. Network Security Config disables cleartext traffic by default and allows it only for loopback. No contacts, call-log, phone-state, microphone, notification-listener, accessibility, or background-service permissions are requested.

## Security boundary

- The client calls `/owner/login`, `/agent`, and `/executions`; authorization and tool governance remain on the canonical server runtime.
- The runtime registers bounded local workspace listing, file reading, literal text search, and project audit tools. File changes are available only as a high-risk, approval-gated change set with precondition checks and verification; the deterministic no-model planner does not invent file contents.
- A task result is displayed only when the HTTP service returns a response. Connection failures are shown as failures, not fabricated success.
- The service remains loopback-bound. External web search, secure LAN/remote transport, caller identification, call actions, notifications, and microphone capture are not implemented in this release.

Future device adapters must request only permissions needed for user-requested features, explain why access is needed, handle denial/revocation, and never capture audio or device activity covertly. Caller lookup is not equivalent to unrestricted call-log access; Android and distribution policies may require supported APIs and user-selected/default-handler roles.

## Next gates

1. Add durable owner sessions and bounded login-failure state on the server.
2. Implement real tool capabilities only behind the canonical runtime's authorization, risk, approval, and audit gates.
3. Add permission-state and API-contract tests for each Android adapter.
4. Add emulator/instrumentation smoke tests before claiming device readiness.
5. Produce a signed release artifact only after security review; no signing secrets belong in the repository.
