# ORIENT ONE — Phase 11 Runtime Agent Boundary Enforcement

## Objective

Turn the Phase 10 agent-boundary definitions into an execution-time guard at the canonical AgentLoop/Runtime boundary.

## Implemented

- `AgentLoop` accepts an `AgentRegistry`.
- Every executable step resolves an `agentId` from the step, plan, or canonical runtime context.
- Every executable step resolves a declared capability, defaulting to `tool:<tool-name>`.
- Undeclared capabilities are rejected with `AGENT_CAPABILITY_FORBIDDEN` before tool execution.
- Boundary decisions are recorded as execution events.
- `OrientRuntime` owns the default canonical `ORIENT_RUNTIME` definition.
- Specialized agents remain explicit: they must be registered and declare their capabilities.
- Wildcard capability support exists only for the canonical runtime compatibility boundary.
- Regression tests cover allow and deny paths.

## Security invariant

Agent identity and capability authorization are runtime-controlled. A request cannot grant itself a capability merely by changing tool input.

## Not yet complete

This phase does not yet make memory scope enforcement or model routing mandatory for every runtime path. Those integrations remain separate gates and must be wired before the full Agent Boundaries + Model Router + Memory architecture is considered production-complete.

## Gate

Strict CI must pass before merge.
