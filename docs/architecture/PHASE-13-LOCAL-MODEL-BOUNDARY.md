# ORIENT ONE — Phase 13 Local Model Boundary

## Decision

ORIENT ONE now has a real zero-budget model-provider path without coupling the Runtime or Planner to a vendor SDK.

The provider boundary is:

`Planner → AgentOrchestrator → ModelRouter → OllamaProvider → local Ollama`

The default remains `ORIENT_MODEL_PROVIDER=none`, so a machine without a local model continues to use the deterministic planner. Enabling the local provider is an explicit deployment decision.

## Enable local inference

Set:

- `ORIENT_MODEL_PROVIDER=ollama`
- `ORIENT_OLLAMA_BASE_URL=http://127.0.0.1:11434`
- `ORIENT_OLLAMA_MODEL=<installed local model>`

The application uses Node's built-in `fetch`; no provider SDK or paid API is required.

## Safety boundary

The model does not execute tools directly. It proposes a plan. `PlanValidator` rejects unregistered tools, and the canonical AgentLoop performs the existing authorization and capability checks immediately before execution.

If the local model is unavailable, times out, returns invalid JSON, or proposes an invalid plan, ORIENT ONE records the model-planning fallback and uses the deterministic planner.

## Production invariant

No model provider may bypass:

1. ModelRouter
2. PlanValidator
3. Agent capability authorization
4. Tool execution authorization
5. Risk/approval controls
6. Durable runtime execution

This preserves ORIENT ONE's canonical Runtime architecture.
