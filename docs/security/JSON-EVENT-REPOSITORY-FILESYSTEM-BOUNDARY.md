# JSON EventRepository Filesystem Security Boundary

## Supported deployment model

The JSON EventRepository is a local-development and single-host persistence adapter. It is not the production multi-instance persistence backend and must not be placed on a network/shared filesystem. Production deployments requiring concurrent instances must use the PostgreSQL persistence adapter.

The event data directory must be a real canonical directory owned by the ORIENT service user with POSIX mode `0700`. Its parent must not be group/world writable unless the sticky bit protects directory entries (for example, a private child under `/tmp`). The adapter fails closed when these assumptions cannot be established.

Safe event-file reads require Node.js `O_NOFOLLOW`, a regular-file descriptor, and a bounded read (64 MiB). Standard Windows Node.js builds without `O_NOFOLLOW` are unsupported by this JSON adapter until a reparse-point-safe implementation is provided. Do not replace this with an `lstat`-then-open fallback.

## Lock lifecycle

Writers acquire an atomic directory lock and create a per-acquisition random owner marker inside it. The marker path is the cleanup capability. Release removes only that exact marker and then uses non-recursive `rmdir`.

Stale, malformed, and legacy locks are never reclaimed automatically. Lock timeout is fail-closed: leave the existing lock untouched and require operator recovery. This avoids check-then-rename races and accidental deletion of a successor's lock.

## Operator recovery

1. Stop every ORIENT process that can write to the JSON data directory.
2. Confirm the data directory is local, private, canonical, owned by the service user, and not shared across hosts.
3. Inspect the lock directory and its contents without following symlinks. Unexpected, missing, malformed, or duplicate owner markers require escalation.
4. Confirm no process can still be using the lock. Do not infer staleness from age alone.
5. Remove only the exact owner marker after independent verification, then use non-recursive directory removal. Never use recursive deletion.
6. Restart ORIENT and verify event history and execution recovery before allowing further writes.

A stale lock is an availability issue, not permission to risk cross-process corruption. If ownership cannot be established, leave it in place and escalate.
