# Durable Mission Events and Recovery

## Authority and ordering

Each workflow is a mission-event aggregate. Events are appended with a stable event ID, tenant ID, aggregate ID, and monotonically increasing aggregate sequence. A replay of the same event ID and payload is idempotent; reusing that ID for a different tenant, aggregate, type, or payload is rejected.

PostgreSQL allocates sequences while holding a transaction-scoped advisory lock for the tenant/aggregate pair. SQLite performs sequence allocation in one write statement. The JSON repository serializes append operations under its storage lock. Aggregate reads are tenant-scoped and sequence-ordered.

## Worker write ordering

Worker lifecycle events are awaited before the worker advances to the next side effect or step. The durable sink appends the event first, then persists the corresponding workflow snapshot. Async worker snapshot writes carry the active worker lease principal. Fencing tokens are not written into mission-event payloads.

The event stream records step start/completion/failure, retries, approval pauses, and workflow state changes. Approval decisions/resolutions and cancellation intent use replayable snapshot-replacement events so state changes that do not correspond to a single step transition are still recoverable.

## Recovery

The async scheduler reconciles persisted workflow snapshots against the mission-event projection before it requests dispatch claims:

1. Load tenant-scoped snapshots and aggregate event streams.
2. Rebuild the workflow projection in sequence order.
3. Reject sequence gaps, identity mismatches, corrupt snapshots, or snapshots ahead of event history.
4. Repair a stale or semantically divergent snapshot with a tenant-scoped compare-and-set.
5. Only then claim eligible queued work. Approval-blocked workflows are excluded from dispatch claims.

Legacy snapshots without mission-event history remain on the legacy recovery path. They are not silently assigned fabricated event history.

## Repair fencing

PostgreSQL repair locks the workflow row and refuses repair while a dispatch claim or worker lease is active. SQLite repair uses a conditional update that checks the expected checkpoint revision, checkpoint timestamp, and absence of an active worker lease. JSON repair uses its storage lock and checks both revision and checkpoint timestamp. The timestamp fence prevents two same-revision semantic repairs from overwriting one another.

Concurrent or active-lease conflicts are retryable on a later recovery pass. Corrupt event history fails closed and prevents the scheduler from claiming work in that recovery cycle.

## Operational boundary

This code supplies durable persistence and recovery wiring. It does not activate the background worker service, enable external outbox publication, change hosted Supabase roles/policies/data, or authorize production deployment. Those remain separate, explicitly gated operational decisions.


## Admission and atomic workflow creation

A new workflow is admitted before its durable creation transaction begins:

1. Reserve an in-memory queue slot synchronously. Pending reservations count against queue capacity and prevent duplicate workflow IDs from being admitted concurrently.
2. Reserve tenant workflow quota. An existing reservation is treated as pre-existing and is not released by a failed retry.
3. Persist the initial workflow snapshot and its ordered `workflow.created` / `CREATED → QUEUED` events. PostgreSQL performs these writes in one owner-scoped transaction; backends without a shared transaction use their documented recovery strategy and fail closed for owner-scoped creation when atomic enforcement is unavailable.
4. Publish the workflow to the in-memory queue only after durable creation succeeds.

If quota reservation or durable creation fails, the scheduler releases only the quota reservation it created and always releases its queue-slot reservation. Concurrent admissions therefore cannot overrun the configured queue depth, and queue-full or quota-denied requests cannot leave a durable queued workflow behind. Recovery capacity calculations include in-flight admission reservations.
