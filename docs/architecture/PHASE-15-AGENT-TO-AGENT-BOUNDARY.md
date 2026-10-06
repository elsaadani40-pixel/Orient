# ORIENT ONE — Phase 15: Agent-to-Agent Boundary

## Objective

Establish an explicit authorization boundary for future agent-to-agent delegation without allowing agents to create or execute arbitrary agents.

## Security model

Every delegation has:

1. source agent identity;
2. target agent identity;
3. target capability, when required;
4. an immutable invocation envelope;
5. an authorization decision performed by AgentInvocationService.

The source agent must declare the target in allowedAgentTargets. The target must be registered and must declare the requested capability.

## Runtime enforcement

AgentLoop accepts an optional AgentInvocationService. A step may declare targetAgentId. Before tool execution, the runtime authorizes the source-to-target relationship and records the decision in the execution trace.

This is an authorization boundary only. Phase 15 does not introduce dynamic agent creation, self-modification, arbitrary code execution, or recursive agent spawning.

## Invariants

- Unknown source agents are denied.
- Unknown target agents are denied.
- Undeclared source-to-target delegation is denied.
- A target capability must be declared by the target agent.
- Delegation metadata is immutable after authorization.
- Existing tool authorization and tenant authorization remain mandatory.
