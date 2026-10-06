# ORIENT ONE — Phase 10 Architecture

## Status

Foundation Gate: PASS on the preceding reliability line.

Phase 10 establishes three boundaries before product/UI expansion:

1. Agent boundaries
2. Model routing
3. Memory access policy

## Agent boundaries

Agents are registered by immutable definitions. A definition declares:

- capabilities the agent may request;
- memory scopes it may access;
- other agents it may invoke;
- risk classification.

An agent does not receive unrestricted runtime or tool access from its identity alone.

The canonical Runtime remains the execution authority. Agent-to-agent invocation is an explicit allow-list decision, not an implicit trust relationship.

## Model Router

The Model Router is a policy boundary, not a model SDK wrapper.

Routing considers:

- required capabilities;
- locality preference;
- cost class;
- provider policy.

Every completion returns routing metadata so the Decision Trace can record why a provider was selected.

Provider adapters own SDK/API details. The router owns selection policy. This prevents the Runtime from becoming coupled to one model vendor.

## Memory architecture

Memory access is scoped by named memory scopes. Agents must be authorized for the scope before reading or writing.

The initial scope vocabulary is intentionally small and explicit. Tenant identity remains outside the agent-provided request and is inherited from the canonical Runtime context.

The existing JSON memory repository remains compatible. Phase 10 introduces the authorization boundary first; storage migration and richer semantic retrieval are subsequent work.

## Non-goals

- No autonomous self-modification.
- No agent-created runtime agents.
- No direct tool execution.
- No UI/Mission Control.
- No provider-specific business logic inside the Runtime.

## Gate

Phase 10 is complete only when:

- boundary unit tests pass;
- router policy tests pass;
- memory access denial is tested;
- routing metadata is traceable;
- CI remains green across supported Node versions.
