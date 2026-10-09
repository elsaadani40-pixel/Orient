# Project Builder resource enforcement

## Threat model

Project Builder commands are untrusted workloads even when the executable is allowlisted. Bubblewrap remains the mandatory filesystem/network namespace boundary; this layer must never invoke an executable directly as a fallback.

The resource supervisor uses a transient **systemd user service** so the kernel/systemd cgroup applies limits to the complete command process tree before the command starts. The service is configured with:

- `MemoryMax`: aggregate memory ceiling for the unit cgroup.
- `CPUQuota`: aggregate CPU-rate ceiling; this is a rate limit, not a total CPU-time budget.
- `TasksMax`: aggregate task/process ceiling.
- `LimitNOFILE`: per-process open-file descriptor ceiling.
- `LimitFSIZE`: per-process maximum regular-file size.
- `RuntimeMaxSec`: service runtime ceiling and a second line of defense alongside the caller timeout.
- `KillMode=control-group` and `OOMPolicy=kill`: terminate the unit's process tree on service stop or cgroup OOM.

The command's captured output also needs a separate byte ceiling enforced by the command runner; truncating retained output alone is not a resource limit.

## Fail-closed requirements

A usable systemd user manager and working cgroup controllers are prerequisites. Missing `systemd-run`, an unavailable user bus, unsupported controllers, or rejected unit properties must fail execution. There is no unsandboxed, direct-spawn, RLIMIT-only, or host-network fallback.

Resource limits apply per command, not as an aggregate per-tenant budget. Multiple commands can each consume their configured maximum unless a separate tenant-level scheduler/quota is implemented.

## Operational limitations

These controls reduce resource exhaustion but do not protect against kernel vulnerabilities, namespace escapes, or denial of service outside the command's delegated unit. Kernel-level isolation remains a separate boundary. CPUQuota limits rate rather than total CPU time; RuntimeMaxSec limits elapsed runtime. Regular-file size limits are not the same as captured stdout/stderr limits.

## Validation

Unit tests cover strict configuration and generated systemd properties. Runtime integration tests must verify that a real command runs in a distinct cgroup and that memory/task/file-size/runtime enforcement behaves as expected on the target Linux kernel. A passing argument-construction test alone is not proof of kernel enforcement.
