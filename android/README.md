# ORIENT ONE Android Companion

**Status: foundation only; not yet connected to the runtime.**

This is a Kotlin/Jetpack Compose Android application module, separate from the platform-neutral Node.js runtime. It builds a local status dashboard that deliberately reports the runtime and all planned capabilities as disconnected.

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

The GitHub Actions workflow `.github/workflows/android-companion.yml` installs the pinned Gradle/JDK toolchain and runs the same tasks.

## Security boundary

The initial manifest intentionally declares no contacts, call-log, phone-state, microphone, notification-listener, accessibility, or background-service permissions. It also does not enable cleartext traffic. No network client is wired yet.

Future capability adapters must:
- request only the permission needed for a user-requested feature;
- explain why access is needed and handle denial/revocation;
- never capture audio or device activity covertly;
- report unavailable/unknown results honestly;
- communicate with a versioned, authenticated runtime API;
- keep authorization, risk checks, approval, and durable audit in the canonical runtime.

Caller lookup is not equivalent to unrestricted call-log access. Android and distribution policies restrict call-log/SMS permissions; implement only through legitimate supported APIs and the relevant user-selected/default-handler requirements where applicable.

## Next gates

1. Add Android unit tests for permission-state and API-contract models.
2. Implement authenticated API client only after the server auth boundary exists.
3. Add explicit, just-in-time permission flows and revocation tests for each adapter.
4. Add emulator/instrumentation smoke tests before claiming device readiness.
5. Produce a signed release artifact only after security review; no signing secrets belong in the repository.
