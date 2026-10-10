# ORIENT Optional Device Permission Policy

**Status:** Product/security requirement. Any feature using a protected device capability must follow this policy before it is described as released.

## User choice is the default

- Device permissions are optional, capability-scoped choices made by the user. Installing or opening ORIENT must not require contacts, microphone, camera, location, call logs, SMS, notifications, files/media, or other sensitive device access merely to use unrelated features.
- Request a runtime permission only when the user explicitly invokes a feature that needs it, and explain the feature-specific purpose before presenting the system permission prompt when a rationale is appropriate.
- Never request a bundle of unrelated permissions, use deceptive prompts, repeatedly nag after denial, or treat denial as consent.
- If a permission is denied, restricted, or revoked, keep the rest of ORIENT usable. Disable or degrade only the dependent feature and explain the limitation without claiming the operation succeeded.
- Provide a way to continue without granting permission. If Android will no longer show the prompt, explain how the user can change the permission in system settings; do not silently open settings or loop prompts.
- Re-check permission state when a feature is invoked or the app resumes. Handle SecurityException, revoked permissions, unavailable hardware, and platform restrictions as normal outcomes.

## Least privilege and data handling

- Prefer Android intents, system pickers, and one-shot access over broad permissions or direct access. Example: open ACTION_DIAL and let the user confirm the call; do not request call permission merely to open the dialer.
- Read contacts locally only after READ_CONTACTS has been granted for the lookup feature. Do not upload or persist contact data unless a separate, explicit, informed action and a documented purpose authorizes it.
- A permission is not authorization to perform every action involving that data. Keep capability authorization, risk classification, and human approval separate from Android OS permission checks.
- Ask for microphone, camera, location, and similar access only for a user-selected feature that actually requires it. No background capture or collection by implication.
- Store the minimum necessary data, state retention clearly, and do not expose private device data to other users, tenants, agents, or logs.

## Task and runtime behavior

- Capability discovery must declare required permissions and clearly distinguish: available, permission required, denied, restricted, unavailable on device, offline, and unsupported.
- If a task needs a missing permission, pause in a truthful needs-user-input or blocked state and identify the exact permission and purpose. Do not fabricate a result or silently switch to a more privileged method.
- The user may grant or refuse. Refusal must not block unrelated tasks; offer a safe alternative where one exists.
- Re-check permission and server-side authorization immediately before a protected operation. A previous grant is not a substitute for current authorization or high-risk approval.
- Offline drafts may be stored only under the app's documented local-data policy and must be labeled unsubmitted; never imply a permission-dependent or server-side action completed while offline.

## Acceptance checks

For every permission-gated feature, tests must cover:
1. Fresh install and use of unrelated features without granting the permission.
2. User invokes the dependent feature and receives a contextual, minimal permission request.
3. Grant permits only the requested capability.
4. Denial leaves unrelated navigation and tasks usable and yields an honest feature-specific message.
5. Permission revocation or “don't ask again” is handled without crashes or repeated prompt loops.
6. Device/platform unavailability is distinguished from permission denial.
7. Sensitive data is not sent to the server or written to logs unless separately justified and authorized.
8. UI tests do not equate OS permission grant with approval for a high-risk operation.

A feature is not fully verified merely because CI builds the app. Record emulator/physical-device evidence for the grant, deny, revoke, and settings recovery paths before marking device behavior verified.
