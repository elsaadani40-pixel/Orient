# Project Operation Receipts

## Purpose

`project.execute_change` may update several workspace files before the runtime persists its own idempotency completion record. A process crash in that interval leaves an uncertain outcome. Matching file bytes alone are not proof that the interrupted operation produced them.

ORIENT ONE therefore records a durable receipt only after the project builder verifies the complete change set. Recovery may report the operation as completed only when a receipt matches the operation identity and the current workspace still matches the recorded change set.

## Receipt identity

Each receipt binds:

- `operationId` — the runtime's logical operation ID.
- `tenantId` — prevents receipt reuse across tenants.
- `workspaceId` — SHA-256 of the canonical allowed workspace root.
- `changeSetHash` — SHA-256 of the normalized ordered change set, including actions, paths, content, and update preconditions.
- `result` — the verified tool result and verification summary.
- `recordedAt` — receipt creation time.

The receipt filename is derived from a hash of tenant ID and operation ID. Receipt files live under the application data directory, outside the workspace exposed to workspace tools.

## Durability and concurrency

The store creates receipt files with restrictive permissions, writes a unique temporary file, fsyncs the file, atomically renames it into place, and fsyncs the containing directory where supported. A per-receipt exclusive lock serializes writers. A stale lock owned by a process that is demonstrably gone on the same host may be quarantined; ambiguous ownership fails closed.

The receipt is written after successful verification and before the tool returns success. A crash after file changes but before receipt persistence remains uncertain and requires controlled recovery. The tool does not replay the change set during reconciliation.

## Recovery rules

- Matching receipt + matching workspace post-state: return the stored verified result.
- Missing receipt, even if the files match: conflict; post-state alone is insufficient.
- Receipt mismatch for tenant, operation ID, workspace, or changeset: conflict; never reuse the receipt.
- Corrupt receipt or ambiguous lock ownership: fail closed.
- Post-state differs from the proposed change set: conflict.
- Same operation ID retried with the same identity and changeset: reuse the durable result rather than writing again.

## Security and guarantees

This is a local durable receipt for the workspace adapter. It is not a cryptographic attestation against a malicious process running with the same operating-system account, nor a distributed consensus protocol. It does not prove exactly-once behavior for network providers, messaging, phone actions, or arbitrary external side effects. Provider-aware idempotency and authoritative reconciliation remain separate requirements.

Production async task acceptance and worker wiring remain disabled until the broader acceptance criteria in issue #189 are satisfied.
