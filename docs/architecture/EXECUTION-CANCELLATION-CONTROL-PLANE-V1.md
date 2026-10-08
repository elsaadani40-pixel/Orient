# ORIENT ONE — Execution Cancellation Control Plane V1

## Contract

Cancellation is a durable intent attached to an executionId, not an in-memory signal.

Flow:

HTTP → AgentService → OrientRuntime.cancelExecution → execution repository

## Safe boundary

The Agent Loop observes the durable cancellation intent before execution work, before authorization/tool side-effect entry, and after the loop returns before the runtime commits completion.

A tool already inside its side-effect boundary is not forcibly interrupted. Existing idempotency/reconciliation remains authoritative so cancellation cannot create a duplicate side effect.

## Recovery

The cancellation intent is persisted with the execution record and restored into ExecutionContext. A restarted runtime therefore observes the same cancellation request instead of relying on process-local state.

## HTTP

- GET /executions/:executionId — status, including cancellation state.
- POST /executions/:executionId/cancel — request durable cancellation.
- POST /executions/:executionId/resume — resume only when the execution remains resumable and safe.

## Security invariants

- tenant scope is enforced at the persistence boundary;
- cross-tenant cancellation returns not-found semantics;
- terminal executions are immutable;
- cancellation does not bypass authorization or idempotency;
- cancellation is cooperative at safe execution boundaries.