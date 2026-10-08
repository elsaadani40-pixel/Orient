# ORIENT ONE — Architecture Ownership Matrix V1

Status: ACTIVE
Scope: Product Core V1
Canonical rule: one concern has one authoritative owner.

## 1. Canonical ownership

| Concern | Authoritative owner | Must not be owned by |
|---|---|---|
| Runtime composition/lifecycle | `OrientRuntime` | feature agents, tools, application services |
| Request → execution context | `RequestExecutionCoordinator` | AgentLoop, WorkflowExecutionCoordinator |
| Goal lifecycle/state | `Goal` + `ExecutionContext` | planners, tools, agents |
| Planning | `PlannerService` | runtime, AgentLoop, tools |
| Plan validation | `PlanValidator` | planner, tools |
| Replanning | `Replanner` | AgentLoop, evaluator |
| Tool registration/discovery | `ToolRegistry` | planner, agents |
| Capability policy | `CapabilityRegistry` / policy layer | tools themselves |
| Authorization | `AuthorizationService` | tools, planner, model |
| Human approval consumption | `ApprovalService` | AgentLoop business logic, tools |
| Step execution | `AgentLoop` | runtime coordinators, individual agents |
| Idempotency | idempotency store/service used by `AgentLoop` | retry policy, tools |
| Recovery decisions | `RecoveryEngine` + execution recovery coordinator | tools, evaluator |
| Observation/event emission | Observation/Event subsystem | ad-hoc feature code |
| Evaluation | `EvaluationEngine` | AgentLoop, planner, model |
| Memory business semantics | `MemoryService` | tools, agents |
| Memory persistence | persistence repository/backend | agents, planner |
| Trace/decision audit | trace/observability subsystem | arbitrary feature code |
| Sandbox policy definition | sandbox policy/security layer | tools alone |
| OS/runtime sandbox enforcement | platform execution adapter | policy metadata |
| Model selection | Model Router | individual feature agents |
| Agent identity/boundaries | Agent boundary layer | runtime-generated arbitrary agents |

## 2. Product Core execution contract

The authoritative path is:

Request
→ RequestExecutionCoordinator
→ Goal/ExecutionContext
→ PlannerService
→ PlanValidator
→ AgentLoop
→ Authorization/Approval
→ Tool
→ Observation
→ EvaluationEngine
→ Memory/Trace
→ Result

A feature must not introduce a second execution path around this contract.

## 3. Coordinator boundaries

### OrientRuntime
Owns composition, dependency wiring, lifecycle and top-level runtime entry.

### RequestExecutionCoordinator
Owns creation and persistence of an execution context and coordination of a single request execution.

### WorkflowExecutionCoordinator
Owns workflow-level orchestration only. It must not become a second AgentLoop or replace Product Core request execution.

### ExecutionPersistenceCoordinator
Owns persistence/checkpoint mechanics. It must not decide business outcomes.

### AgentLoop
Owns bounded step execution, authorization handoff, idempotency/recovery handling, tool invocation and step completion. It does not own planning or evaluation policy.

## 4. Governance invariants

1. No second runtime.
2. No second planner/orchestrator hidden inside a feature agent.
3. Authorization is mandatory at the execution boundary; model output is never authority.
4. High-risk state changes require explicit approval according to policy.
5. Approval tokens are execution-scoped and single-use.
6. Persisted RUNNING/UNKNOWN operations are reconciled before retry.
7. Evaluation is observational and authoritative for step outcome; it does not execute tools.
8. Memory records facts/provenance according to its own policy; inference is not silently promoted to fact.
9. Sandbox policy metadata is not OS-level enforcement.
10. New agents cannot self-create/self-run inside the runtime during Product Core V1.
11. Distributed scheduling remains outside Product Core V1 unless a concrete requirement proves it necessary.
12. Every new coordinator must document the exact ownership it adds and the ownership it explicitly does not have.

## 5. Change gate

Before adding a new service/coordinator/agent, answer:

- What existing owner cannot safely own this responsibility?
- What exact invariant requires a new boundary?
- Which existing owner loses responsibility, if any?
- What test proves there is no duplicate orchestration?
- Does this change alter the canonical Product Core path?

If these questions cannot be answered, the change is not ready for implementation.

## 6. External architecture influence

Ideas from ZeroClaw, OpenClaw, Letta, Mem0 and sandbox runtimes may inform adapters and boundaries, but ORIENT ONE remains the source of truth for:

Runtime → Policy → Authorization → Tool → Execution → Evaluation → Memory → Trace.

No external project becomes a replacement runtime, planner, memory authority or governance authority.
