# ORIENT ONE — Phase 12 Runtime Integration

## Status

Implementation phase for integrating the Phase 10 boundaries into the application/runtime composition.

## Memory boundary

- MemoryAccessPolicy is installed at the application composition root.
- MemoryService authorizes every read/write/delete operation using the executing agent identity.
- Memory is scoped by named memory scope.
- JSON memory persistence is tenant-scoped.
- Tool execution receives the canonical runtime context, including agent and tenant identity.
- Legacy memory remains readable under the local tenant.

## Model boundary

- ModelRouter is installed at the application composition root.
- AgentOrchestrator owns the model-routing boundary rather than planner code selecting providers directly.
- Planner calls receive the router through the planning boundary.
- Explicit model completion calls return routing metadata and publish a model.routing.completed event for traceability.
- No paid provider is configured. This preserves the zero-budget/local-first architecture.

## Safety

- Agents cannot access memory scopes outside their definition.
- Tenant identity comes from runtime context rather than model/planner input.
- Model provider selection remains centralized in ModelRouter.
- No direct provider SDK is introduced into the Runtime.

## Verification gate

Required before merge:
1. memory agent-scope tests;
2. tenant-isolation tests;
3. model-router runtime boundary tests;
4. existing full Strict CI;
5. architecture review of the resulting composition root.

## Next boundary

A concrete model provider adapter may be added only when an actual local/open/free model provider is selected. The Runtime must continue to use ModelRouter; provider-specific logic must not leak into the Planner or Runtime.
