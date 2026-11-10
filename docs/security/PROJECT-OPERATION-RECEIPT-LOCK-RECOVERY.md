# Project Operation Receipt Lock Recovery

## Scope

The receipt store uses an atomic directory lock at:

`<receipt-directory>/<sha256(tenantId + NUL + operationId)>.json.lock/`

A newly acquired lock contains one owner marker named `owner.<random-token>.json`. The marker records the token, process ID, and acquisition timestamp. The store deliberately does not reclaim stale locks automatically: a false stale-owner decision could permit duplicate project side effects.

The receipt directory must be local application data, not the project workspace or a shared/network filesystem. On POSIX systems it must be owned by the ORIENT service user and have mode `0700`. Its immediate parent must not be group/world writable unless the sticky bit protects directory entries (for example, a private child under `/tmp`).

## Platform support

Safe receipt and intent reads require Node.js `fs.constants.O_NOFOLLOW`. On standard Node.js Windows builds where this flag is unavailable, the store deliberately fails closed with `PROJECT_OPERATION_RECEIPT_UNSAFE_FILESYSTEM` or `PROJECT_OPERATION_INTENT_UNSAFE_FILESYSTEM`. Do not replace this with an `lstat`-then-`open` fallback.

Windows receipt-backed project operations remain unsupported until a separate implementation can open reparse points safely and verify service-account ACLs. POSIX Linux, macOS, and Android/Termux builds use the no-follow descriptor path; the receipt directory must still satisfy the ownership and mode checks below.

## Operator procedure

1. **Stop every ORIENT process that can write to this receipt directory.** Do not attempt recovery while any instance is running. If the directory is on a shared or network filesystem, do not perform this procedure; treat the store as unsupported and escalate.
2. Resolve the lock path for the affected `tenantId` and `operationId`. The receipt filename digest is SHA-256 over the UTF-8 bytes of `tenantId`, one NUL byte, then `operationId`. The lock path is that receipt filename plus `.lock`.
3. Inspect the lock directory without changing it. It must be a real directory, owned by the ORIENT service user, with mode `0700`. There must be exactly one regular owner marker named `owner.<token>.json`. Do not follow symlinks.
4. Read the marker and validate its token, positive integer PID, and acquisition timestamp. If the marker is missing, malformed, duplicated, or accompanied by unexpected files, **stop and escalate**. Do not use recursive deletion.
5. Verify the recorded PID on the same host. If `kill -0 <pid>` succeeds, or fails with a permission error, treat the owner as live and do not remove the lock. If the PID is absent, re-check that all ORIENT instances are stopped and that the PID has not been reused before proceeding.
6. Remove only the exact owner marker after verifying its name and type, then use non-recursive `rmdir` on the lock directory. If either operation fails, stop; do not retry with `rm -rf`.
7. Restart ORIENT and verify that the interrupted operation is reconciled from its durable intent/receipt state before allowing another project mutation.

## Important

- Never remove a lock merely because it is old.
- Never remove a lock while an ORIENT process may still be writing.
- Never delete the receipt, pending intent, or temporary receipt files as part of lock recovery.
- Preserve the inspected marker contents and timestamps in the incident record.
- If safe ownership cannot be established, leave the lock in place and escalate. Fail-closed availability loss is preferable to duplicate or cross-tenant side effects.
