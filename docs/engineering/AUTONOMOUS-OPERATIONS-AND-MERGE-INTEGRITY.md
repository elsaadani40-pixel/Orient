# ORIENT Autonomous Operations and Merge Integrity Law

**Status:** Proposed engineering policy; implementation and operational activation are not yet proven.  
**Owner:** ORIENT project owner  
**Control issue:** [#328 — Master Engineering & Hardening Program](https://github.com/elsaadani40-pixel/Orient/issues/328)  
**Operating target:** 24/7 autonomous execution, subject to safety, resource, and authorization gates.

## 1. Purpose and authority

ORIENT is intended to continue approved engineering work when the owner is asleep, busy, or not connected to ChatGPT. A normal ChatGPT conversation is not the worker and is not a durable execution host. Continuous operation requires a separately deployed worker service, durable state, credentials with bounded permissions, monitoring, and recovery.

This document defines the target operating policy. It does not claim that a 24/7 worker has already been deployed. No production worker, paid infrastructure, hosted database mutation, public deployment, or release is authorized by this policy alone.

The owner retains authority over scope, risk policy, resource commitments, release, deployment, and explicit stop/resume commands.

## 2. Continuous operation

The target service must run continuously and resume approved work after process, host, or network interruption. It must not depend on an open ChatGPT session, a live phone, or the owner's availability.

Required components:
- durable task queue and task-state store;
- supervisor and bounded worker pool;
- task leases, heartbeats, fencing tokens, and idempotency keys;
- isolated execution environments;
- policy and authorization gateway;
- independent verification stage;
- append-only audit trail;
- health monitoring, alerting, backup, and tested recovery.

A scheduler or GitHub Actions workflow alone is not a continuously reasoning worker. Scheduled workflows may perform bounded checks, but durable orchestration and recovery must live in a separately managed service.

## 3. Autonomous work cycle

For each approved task, the system must:
1. load the task, dependencies, policy, and last verified checkpoint;
2. confirm that the task remains authorized and its inputs are current;
3. produce a bounded execution plan and explicit success criteria;
4. execute in an isolated workspace and least-privilege identity;
5. run task-specific tests and security checks;
6. produce a reviewable change set and evidence bundle;
7. request independent review where required by risk;
8. open or update one coherent pull request for the bounded workstream;
9. wait for all required pre-merge gates;
10. merge only if the repository's merge policy and owner authorization permit it;
11. validate the exact resulting main commit after merge;
12. record evidence and select the next eligible task.

Do not create a new commit for every tiny action. Group related changes into coherent, reviewable slices. Keep one active implementation branch per bounded workstream unless parallel branches have explicit non-overlapping ownership and dependencies.

## 4. Mandatory pre-merge gates

A pull request is not merge-ready until all applicable gates pass on its exact head SHA:
- unit and architecture tests;
- integration and contract tests;
- full repository test suite;
- database integration and migration checks when persistence changes;
- browser acceptance when web behavior changes;
- Android tests/build when Android behavior changes;
- static safety, secret scanning, and CodeQL;
- security, authorization, tenant-isolation, replay, idempotency, and concurrency tests as applicable;
- performance/load/failure tests when the change affects those boundaries;
- review of the actual diff and all unresolved review threads;
- no merge conflicts, stale required checks, or unreviewed generated artifacts.

A green check on an earlier SHA does not qualify a later SHA. A PR description or local test claim is not evidence.

## 5. Mandatory post-merge gates

**A successful GitHub merge is not proof of a successful integration.** Every merge must trigger validation on the resulting `main` commit.

The post-merge gate must:
- capture the merge commit SHA and confirm it is the current intended mainline result;
- run the required main-branch CI on that exact SHA;
- run the full repository suite and relevant database integration;
- run browser acceptance and Android validation when applicable;
- run security/static checks required for the changed surface;
- run smoke tests against the composed application and critical owner/runtime paths;
- verify migrations, persistence compatibility, and recovery behavior when relevant;
- inspect failures and compare results with the pre-merge evidence;
- record workflow URLs, job conclusions, artifacts, timestamps, and tested SHA.

A task is complete only after post-merge validation passes and the evidence is attached to its tracking issue or audit record.

If post-merge validation fails:
1. mark the merge as **integrated but not validated**;
2. stop merging dependent or overlapping changes;
3. preserve logs and artifacts and identify the first failing boundary;
4. determine whether a forward fix or a controlled revert is safer;
5. do not delete evidence or weaken tests to obtain a green result;
6. resume dependent work only after recovery and post-recovery validation pass.

Independent, non-dependent work may continue only if it cannot worsen or conceal the incident and the supervisor records the isolation decision.

## 6. Merge integrity and anti-chaos rules

- Never push directly to `main` as a normal development path.
- Do not merge a draft PR or a PR with unresolved blocking review.
- Verify the exact tested head SHA immediately before merge.
- Never merge based solely on PR count, green badges, or elapsed time.
- Do not create duplicate/no-op commits or repeated PRs for the same change.
- Prefer one coherent PR per bounded workstream, with related files and tests grouped together.
- Rebase or update a branch only after understanding divergence and preserving its intended changes.
- Keep the master tracker (#328) as the source of truth; link work rather than creating competing plans.
- Preserve a clear distinction between proposed, implemented, tested, merged, and post-merge-verified states.

## 7. Risk and authorization boundaries

The worker may autonomously inspect, test, document, create branches, and open PRs within its granted permissions.

The worker must stop and request owner authorization before:
- changing project scope or core product direction;
- changing security policy, permission boundaries, or its own authority;
- accessing or rotating owner credentials or secrets;
- creating paid infrastructure or accepting new recurring charges;
- mutating hosted production databases or cloud infrastructure;
- publishing a release or deploying a public production service;
- merging where the master issue or repository policy requires separate owner authorization.

High-risk security, identity, persistence, authorization, and data-integrity changes require independent review. The worker cannot approve its own high-risk change or weaken the gate that constrains it.

## 8. Durable execution, retries, and recovery

- Persist task state before and after externally visible side effects.
- Use idempotency keys and authoritative reconciliation for every mutating provider operation.
- Use lease ownership and fencing to reject stale workers.
- Bound retries, timeouts, concurrency, CPU, memory, storage, and model usage.
- Treat uncertain external outcomes as unknown until reconciled; never blindly replay.
- On restart, recover from durable checkpoints and reconcile in-flight operations before retrying.
- Maintain tested backups and document restore procedures.
- Isolate a failed task while allowing unrelated safe work to proceed.

Production asynchronous task execution remains disabled until the acceptance gates in Issues #185 and #189 are fully satisfied.

## 9. Stop and resume protocol

The owner command `ORIENT STOP` must:
- stop dispatching new tasks;
- prevent new merges and external side effects;
- safely drain or cancel active work according to task state;
- persist checkpoints and unresolved operation identifiers;
- preserve logs and audit records;
- report the confirmed stopped state.

The owner command `ORIENT RESUME` may resume only after verifying service health, credentials, task leases, unresolved side effects, and policy version. A stop command must not be ignored or undone by an automatic restart.

An emergency safety stop may suspend affected work without waiting for the owner when compromise, data corruption, unauthorized access, or loss of execution integrity is detected.

## 10. Monitoring and resource limits

The service must expose health, heartbeat age, queue depth, task age, retry count, failure rate, worker utilization, resource consumption, and last successful recovery. Alerts must be routed through a configured channel and must not assume that ChatGPT is open.

Continuous operation must have explicit cost and resource ceilings. On reaching a ceiling, the worker must stop expensive non-critical work, preserve state, and alert the owner. It must not silently provision paid capacity or incur recurring charges.

## 11. Implementation sequence and acceptance criteria

### Phase A — Truth and architecture
- reconcile this policy with Issue #328 and current Runtime/shutdown/approval architecture;
- inspect existing queues, persistence, leases, idempotency, worker composition, and monitoring;
- document gaps and threat model before implementation.

**Exit:** reviewed architecture and gap map; no duplicate worker or queue introduced.

### Phase B — Durable worker foundation
- implement durable task state, leases/fencing, bounded supervisor, graceful shutdown, and restart recovery;
- keep production async execution disabled until Issues #185/#189 gates pass.

**Exit:** deterministic crash/restart, stale-lease, duplicate-delivery, and cancellation tests pass.

### Phase C — Governed execution
- route every tool through ToolSpec and the unified authorization/risk/approval/audit gateway;
- add isolated execution, idempotency, reconciliation, and independent verification.

**Exit:** authorization, tenant-isolation, replay, failure, and side-effect tests pass.

### Phase D — CI and merge controller
- enforce exact-SHA pre-merge gates;
- add post-merge validation against the resulting main SHA;
- prevent dependent merges after post-merge failure;
- record all evidence in the master issue.

**Exit:** controlled test demonstrates both successful merge verification and failure containment/recovery.

### Phase E — 24/7 operational pilot
- deploy only to an owner-approved environment and cost ceiling;
- run a non-production pilot with bounded, low-risk tasks;
- test host restart, network loss, model-provider outage, STOP, and RESUME.

**Exit:** independently verified uptime/recovery evidence, bounded costs, correct stop behavior, and no duplicate side effects.

### Phase F — Controlled expansion
- expand task classes only after each class passes its own risk and acceptance gates;
- production async, public deployment, and release remain separately gated.

**Exit:** owner-approved operational review with evidence for each enabled capability.

## 12. Definition of done

The 24/7 capability is not complete merely because a process starts. It is complete only when:
- the worker runs independently of ChatGPT and the owner's phone;
- task state survives process and host restarts;
- leases, fencing, idempotency, and reconciliation prevent duplicate effects;
- STOP and RESUME behave as specified;
- pre-merge and post-merge validation are both enforced;
- failures are isolated, observable, and recoverable;
- permissions and resource limits are proven;
- the pilot has documented operational evidence.

**Final rule:** ORIENT should continue approved work while its owner is unavailable, but it must never trade safety, correctness, transparency, or owner authority for uninterrupted activity.
