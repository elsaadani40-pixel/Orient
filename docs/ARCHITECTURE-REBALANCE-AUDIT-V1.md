# ORIENT ONE — Architecture Rebalance Audit V1

Date: 2026-10-07
Baseline: V6.2 durable fair dispatch / capability routing

## Executive decision

ORIENT ONE has crossed the point where additional distributed-runtime work should be paused.

The current architecture is strong enough to support product execution. The next work must increase user capability and end-to-end mission reliability, not add more infrastructure layers.

**Policy:** freeze new distributed-runtime features unless a demonstrated product workload requires them.

## Current operational layers

### Operational
- Canonical AgentOrchestrator
- Planning and plan validation
- AgentLoop execution
- Capability registry/governance
- Authorization and durable approvals
- Idempotency and crash-safe recovery boundaries
- Memory Intelligence V1–V4
- Durable JSON/PostgreSQL persistence foundation
- Durable worker registration and workflow dispatch
- Fair dispatch, backpressure and capability-aware worker routing
- Event bus/store and execution persistence
- Retry, replanning and recovery primitives

### Partially integrated / product-facing gaps
- EvaluationEngine exists but the AgentLoop still owns step evaluation logic directly.
- Goal entity exists, but request execution still generates an execution goal identity rather than running a full Goal lifecycle as a first-class application workflow.
- Model routing is present, but the deterministic planner remains the reliable product fallback.
- The available tool surface is still dominated by memory capabilities.
- External-world adapters (web, communications, calendar, phone, files) are not yet a broad production tool portfolio.
- A complete user-facing mission acceptance suite is still smaller than the infrastructure test surface.

## Main architectural finding

The repository is no longer blocked by runtime infrastructure.

The highest-value gap is now **capability depth**:

Goal → Plan → Risk → Approval → Tool → Execution → Memory → Trace → Result

must become a repeatedly demonstrated product path.

## Complexity freeze

Do not start:
- V6.3 distributed scheduling
- additional worker orchestration layers
- new speculative event buses
- microservices
- new persistence backends
- autonomous self-modification
- self-created runtime agents

unless a concrete product requirement proves the need.

Existing distributed infrastructure remains preserved and available.

## Product track

### Mission V1 — Memory-backed personal mission
A low-risk mission must prove:
1. natural-language request enters the runtime
2. deterministic/model-assisted planning selects a valid tool
3. capability governance authorizes the tool
4. tool executes
5. observation/evaluation is recorded
6. memory state is updated or queried
7. durable execution/events remain inspectable
8. user receives a truthful result

### Mission V2 — Approved side effect
After V1 is stable, add one bounded side-effecting adapter and prove:
1. risk classification
2. durable approval issuance
3. exact approval scope
4. single-use consumption
5. idempotency
6. recovery without duplicate side effects
7. complete audit trace

## Product capability priority

1. Memory + context
2. Research/web adapter
3. File workspace
4. Tasks/reminders
5. Calendar
6. Communications
7. Android adapters
8. Multi-agent delegation where responsibility boundaries justify it

## Definition of progress

Infrastructure maturity is no longer the primary progress metric.

Future progress must be measured by:
- number of real missions completed safely
- mission success rate
- recovery success rate
- approval correctness
- memory usefulness
- tool coverage
- offline behavior
- user-visible value

## Architecture rule going forward

Every new subsystem must answer:

**What real user mission becomes possible because this exists?**

If the answer is unclear, defer it.

## Target next milestone

**Product Core V1:** one real end-to-end mission, fully observable, testable, recoverable, and safe.

No V6.3 until Product Core V1 demonstrates an actual architectural need for more distributed capability.
