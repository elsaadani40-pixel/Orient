# ORIENT ONE — Product Mission V1

## Mission

Prove the first complete low-risk personal-AI loop using the existing runtime:

**User Goal → Plan → Capability/Risk → Tool → Execution → Memory → Trace → Result**

## Acceptance criteria

- Request enters through the existing AgentService/runtime path.
- Planner produces a bounded plan using a registered tool.
- Plan validation rejects unknown or invalid tools.
- Capability governance and authorization are applied.
- Tool execution is idempotent.
- Execution observations and evaluations are persisted.
- Memory changes retain provenance and audit history.
- Execution and event records remain correlated.
- Failure does not fabricate success.
- Resume/recovery does not duplicate a completed side effect.
- Offline operation does not invent external information.

## First mission class

Use a local-memory mission before introducing external side effects.

Examples:
- save a user-provided fact
- retrieve a previously saved fact
- search memory and return the relevant result

This is intentionally low-risk. It validates the core product loop before adding communications, web, calendar, or phone actions.

## Next mission class

Introduce exactly one bounded external side effect behind the existing authorization/approval boundary.

The side effect must be:
- explicitly authorized
- durably approved
- idempotent
- auditable
- recoverable

## Non-goals

This milestone does not add:
- another distributed scheduler
- another persistence backend
- self-modifying runtime behavior
- autonomous agent creation
- microservices

## Completion standard

A mission is complete only when both the happy path and the important failure/recovery path are tested.
