# ORIENT ONE — Phase 16: Capability & Tool Governance

## Objective

Make tool capability governance an enforced runtime boundary rather than a passive registry.

## Security invariant

For every tool execution:

1. the tool must be registered;
2. the tool must have a capability mapping;
3. the mapped capability must exist in the CapabilityRegistry;
4. the executing agent must declare that capability;
5. the existing AuthorizationService and approval/risk checks remain mandatory.

The agent-facing tool capability (for example `tool:memory.search`) and the policy capability (for example `memory.read`) are intentionally separate layers: the former identifies the concrete execution surface, while the latter defines the security policy being exercised.

This phase does not grant new permissions automatically and does not introduce remote execution, dynamic agents, or self-modification.

## Verification

The phase adds unit coverage for mapping/registry/agent enforcement and runtime enforcement before tool execution.
