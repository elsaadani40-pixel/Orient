# Project Builder resource enforcement

## Threat model

Project Builder commands are untrusted workloads even when the executable is allowlisted. Bubblewrap remains the mandatory filesystem/network namespace boundary; this layer must never invoke an executable directly as a fallback.

The resource supervisor uses a transient **systemd user service** so the kernel/systemd cgroup applies limits to the complete command process tree before the command starts. The service is configured with:

- `MemoryMax`: aggregate memory ceiling for the unit cgroup; `MemorySwapMax=0` prevents additional swap-backed memory for the unit.
- `CPUQuota`: aggregate CPU-rate ceiling, paired with per-process `LimitCPUSoft`/`LimitCPU` soft-hard CPU-time limits and unit-level `RuntimeMaxSec`. CPUQuota itself is a rate limit, not a total CPU-time budget.
- `TasksMax`: aggregate task/process ceiling.
- `LimitNOFILE`: a supervisor-level descriptor floor that keeps the trusted preflight helper functional. After the cgroup properties are verified, `prlimit` applies the configured per-process descriptor ceiling to Bubblewrap and its untrusted command before that command starts.
- `LimitFSIZE`: per-process maximum regular-file size.
- `RuntimeMaxSec`: service runtime ceiling and a second line of defense alongside the caller timeout.
- `KillMode=control-group` and `OOMPolicy=kill`: terminate the unit's process tree on service stop or cgroup OOM.

The command's captured output also needs a separate byte ceiling enforced by the command runner; truncating retained output alone is not a resource limit.

## Fail-closed requirements

A usable systemd user manager and working cgroup controllers are prerequisites. Missing `systemd-run`, an unavailable user bus, unsupported controllers, missing `prlimit`, or rejected unit properties must fail execution. The in-unit preflight verifies the effective cgroup properties before Bubblewrap starts; the requested per-process descriptor limit is then applied with `prlimit`. There is no unsandboxed, direct-spawn, RLIMIT-only, or host-network fallback.

Resource limits apply per command, not as an aggregate per-tenant budget. Multiple commands can each consume their configured maximum unless a separate tenant-level scheduler/quota is implemented.

## Operational limitations

These controls reduce resource exhaustion but do not protect against kernel vulnerabilities, namespace escapes, or denial of service outside the command's delegated unit. Kernel-level isolation remains a separate boundary. CPUQuota limits rate rather than total CPU time; RuntimeMaxSec limits elapsed runtime. Regular-file size limits are not the same as captured stdout/stderr limits.

## Validation

Unit tests cover strict configuration and generated systemd properties. Runtime integration tests must verify that a real command runs in a distinct cgroup and that memory/task/file-size/runtime enforcement behaves as expected on the target Linux kernel. A passing argument-construction test alone is not proof of kernel enforcement.
