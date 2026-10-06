# ORIENT ONE — Phase 14 Agent Platform

## Objective

Turn the existing canonical Runtime into a real multi-agent platform without weakening the Runtime authority.

## Agent manifests

The default catalog defines explicit specialist agents:

- MEMORY_AGENT: memory read/write/delete tools, local text-generation capability, personal/shared-memory scopes, and delegation to RESEARCH_AGENT.
- RESEARCH_AGENT: memory search/list, local text-generation capability, personal/research scopes, and delegation to MEMORY_AGENT.
- ORIENT_RUNTIME: canonical execution authority with wildcard capabilities for runtime compatibility and critical risk.

Agent definitions are executable authorization data, not documentation-only labels.

## Planning and routing

The planner assigns every plan to a specialized agent. Memory intents resolve to MEMORY_AGENT; other intents resolve to RESEARCH_AGENT.

ModelRoutingPolicy enforces local providers by default and requires the executing agent to declare every requested model capability. Provider selection remains centralized in ModelRouter.

A model can therefore propose a plan, but it cannot bypass agent/tool authorization.

## Execution boundary

request → Planner → Agent assignment → ModelRouter → PlanValidator → AgentLoop → Agent capability gate → Tool authorization → Tool

The agent identity is persisted in the plan fingerprint and runtime checkpoint metadata so a resumed execution cannot silently switch agent ownership.

## Verification

Phase 14 includes agent manifest/delegation tests, agent-aware model routing tests, planner agent assignment, and an end-to-end test using a local model provider, specialized MEMORY_AGENT, real OrientRuntime, PlanValidator, AgentLoop, and a registered tool.

The end-to-end test verifies the tool receives MEMORY_AGENT identity, the exact capability, and the runtime tenant identity.

## Security invariant

No specialist agent executes outside the canonical Runtime. Model output is untrusted planning input and must pass the same validation and authorization gates as deterministic plans.
