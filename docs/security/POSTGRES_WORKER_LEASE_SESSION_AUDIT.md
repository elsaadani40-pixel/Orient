# PostgreSQL Worker Lease Session Audit

## Status

The worker lease lifecycle is now session-bound in the application persistence layer. This is a bounded hardening milestone, not proof of complete worker isolation.

## Database contract

Migration v11 adds `workflow_leases.worker_session_id`. A durable lease records the exact worker process session that acquired it, alongside its existing worker ID, lease ID, and monotonic fencing token.

## Admission

Lease acquisition runs in a worker-principal transaction and locks the worker registry row. Admission requires all of the following:

- tenant ID matches the worker principal;
- worker ID and session ID match the currently registered row;
- worker status is `READY`;
- worker registration has not expired;
- workflow exists in the same tenant and is not terminal or durably cancelled.

## Lease lifecycle

Renewal, current-lease assertion, save, and release require a lease-bound worker principal containing tenant, worker, session, workflow, lease ID, and fencing token. Each mutation rechecks the live worker registry session and constrains the SQL operation by all lease ownership fields.

A replacement worker session cannot renew, assert, or release the previous session's lease. A worker principal bound to a different workflow, lease ID, or fencing token is rejected before SQL.

## Recovery and compatibility

Expired lease cleanup remains a maintenance operation scoped by tenant/workflow/lease and expiry. Existing leases migrated with an empty `worker_session_id` are not renewable by a newly authenticated worker; they must expire and be recovered through normal queue recovery.

## Explicit remaining gaps

- Workflow payload, event, and checkpoint writes are not yet committed under the lease-bound worker principal in the same transaction as lease validation.
- Delegated owner authority for worker-originated execution writes is not yet implemented.
- Tenant quota mutations and global maintenance operations still need distinct system/service principals.
- PostgreSQL RLS policies, hosted grants, and production runtime credentials remain gated until end-to-end principal propagation and adversarial isolation tests are complete.

Do not interpret green CI for this slice as approval to enable hosted RLS policies or switch production credentials.
