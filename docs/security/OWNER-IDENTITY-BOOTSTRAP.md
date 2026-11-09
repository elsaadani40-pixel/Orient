# ORIENT owner identity bootstrap

## Canonical identity

The website and Runtime share one canonical owner identity record at the configured owner-state path. The owner email is normalized with trim + lowercase and defaults to the product-approved address. Override it only through the protected `ORIENT_OWNER_EMAIL` deployment setting.

The owner identity is separate from public customer-account records. Public registration cannot create or promote an owner. Owner capabilities are granted only after the canonical identity service validates the password and creates an owner session.

## First-run setup

Before the first production start, configure both values in the deployment platform's encrypted secret/environment settings:

- `ORIENT_OWNER_EMAIL`: the canonical owner email.
- `ORIENT_OWNER_BOOTSTRAP_PASSWORD`: exactly 10 ASCII digits.

Do not put either value in source code, a checked-in `.env` file, GitHub issues or pull requests, build artifacts, Android packages, screenshots, logs, or support messages. The first-run password is never returned by an API and is persisted only as a salted scrypt verifier in the owner identity store.

The application refuses first-run production startup if the bootstrap secret is absent or is not exactly 10 digits. Once the owner state file exists, the bootstrap secret is no longer used to authenticate; changing the environment variable does not rotate an existing owner password.

## First sign-in and rotation

1. Open the ordinary ORIENT sign-in page.
2. Enter the canonical owner email and the 10-digit bootstrap password.
3. ORIENT creates an owner session and marks it as requiring password rotation.
4. The shared account workspace presents the mandatory password-change form. Owner management APIs remain blocked while rotation is pending.
5. Choose a new password of at least 14 characters. The identity service revokes prior owner sessions and issues a fresh session with a fresh CSRF token.
6. The owner then uses the same sign-in form as every other account. The shared workspace adds owner-only controls based on the server-authenticated owner session.

## Recovery and rotation

For a forgotten or compromised permanent password, use the documented owner identity recovery procedure for the deployment environment. Do not overwrite or delete the owner-state file as a shortcut: it contains the canonical verifier and session lifecycle state, and replacing it without a controlled recovery procedure can lock out Runtime and website owner access.

A bootstrap secret supplied after the owner-state file has already been initialized does not reset the account. Recovery must be an explicit operator-controlled action with an audited backup and rollback plan. Rotate the permanent password from the authenticated owner workspace whenever possible, then revoke all other owner sessions.

## Android boundary

The Android companion currently authenticates to the local ORIENT Runtime using the Runtime owner-session contract. That local Runtime authority is intentionally not silently converted into a public website/customer login. Any future cross-device public identity bridge must explicitly define token audience, device binding, revocation, offline behavior, and owner-vs-customer authorization before implementation.
