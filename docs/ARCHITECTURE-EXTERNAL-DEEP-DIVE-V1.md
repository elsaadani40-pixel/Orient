# ORIENT ONE — External Architecture Deep-Dive V1

## Status

IMPLEMENTED AS AN ARCHITECTURE INPUT — no external framework is adopted as a runtime dependency.

## Scope

This review studied five projects against the current ORIENT ONE architecture:

1. ZeroClaw
2. OpenClaw
3. Letta
4. Mem0
5. Anthropic Sandbox Runtime

The objective is to extract high-value patterns without replacing ORIENT ONE's canonical runtime.

## Decisions

### 1. ZeroClaw — ADAPT

Adopt the architectural principle of small, explicit capability contracts.

ORIENT already has a ToolRegistry and authorization pipeline. Tool metadata now carries:

- capabilities
- risk classification
- optional sandbox requirement/profile

No ZeroClaw runtime or Rust dependency is introduced.

### 2. OpenClaw — INSPIRE

Adopt the gateway/control-plane separation as a future integration boundary.

Decision:

- Runtime remains the canonical execution owner.
- Future channels/adapters must enter through explicit runtime boundaries.
- No second agent gateway/runtime is introduced.

### 3. Letta — ADAPT

Adopt the stateful-agent principle:

- stable agent identity
- persistent memory across sessions
- explicit state ownership

ORIENT already has ExecutionContext, goalId, tenant/scope-aware memory, and durable checkpoints. No Letta runtime is imported.

### 4. Mem0 — ADAPT SELECTIVELY

Study and selectively incorporate:

- entity-aware retrieval
- hybrid lexical/semantic ranking
- temporal metadata
- deduplication and conflict resolution

ORIENT's Memory V4 remains canonical because it already provides provenance, confidence, evidence, verification, temporal validity, supersession, audit, and tenant isolation.

Future memory improvements must be benchmarked against the existing deterministic scoring and conflict-resolution model.

### 5. Anthropic Sandbox Runtime — ADOPT THE SECURITY CONTRACT

Adopt the security principle of explicit filesystem/network boundaries for untrusted tool execution.

The first integration is a framework-neutral sandbox policy contract with deny-by-default write/network semantics.

The policy is intentionally only a contract at this stage. Actual OS sandbox enforcement belongs behind a platform adapter and must never be simulated by policy metadata alone.

## Explicit Non-Decisions

We do NOT adopt:

- a second agent runtime
- a second planner/orchestrator
- a replacement memory system
- autonomous self-modification
- distributed infrastructure
- a mandatory vector database
- a mandatory external LLM provider
- an external framework as a core dependency

## Architectural Rule

External projects are references and sources of proven patterns, not ownership authorities.

ORIENT ONE remains the source of truth for:

Runtime -> Policy -> Authorization -> Tool -> Execution -> Evaluation -> Memory -> Trace

## Next safe evolution

1. Add entity-aware memory retrieval only after benchmark tests.
2. Add a real sandbox adapter for shell/filesystem/browser tools.
3. Expand Tool metadata into capability declarations used by governance.
4. Build the first real Product Core mission.
5. Re-evaluate only after measured product need.
