# ORIENT PostgreSQL owner-attribution migration

Status: operator procedure for schema migration 14  
Scope: PostgreSQL databases upgrading from schema version 13 or earlier

## Why migration 14 can stop

Migration 14 changes the `executions` row policy from tenant-only isolation to tenant **and owner** isolation. Older execution rows do not have an `owner_id` value. ORIENT cannot safely infer the owner from `tenant_id`, an execution payload, or the current login.

The migration therefore adds the nullable column inside its transaction and then checks for any row where `owner_id IS NULL`. If one exists, it raises an error and the entire migration transaction rolls back. The schema version remains unchanged and the previous tenant-scoped policy remains active. This is deliberate fail-closed behavior: it prevents a successful upgrade that silently makes historical executions inaccessible.

## Required operator action

1. Stop ORIENT writers and take a verified database backup.
2. Determine the real owner of every existing execution using authoritative records outside this migration. Do not guess from tenant IDs.
3. Connect with the restricted migration login and assume the `orient_owner` role (or use an equivalently controlled administrative session).
4. Add the nullable column and populate it with an explicit mapping while schema version 14 is still unapplied:

```sql
SET ROLE orient_owner;

ALTER TABLE public.executions
  ADD COLUMN IF NOT EXISTS owner_id UUID;

-- Example ONLY for a verified single-owner legacy installation:
UPDATE public.executions
SET owner_id = '11111111-1111-4111-8111-111111111111'::uuid
WHERE owner_id IS NULL;

-- For a multi-owner database, replace the example UPDATE with a reviewed
-- execution_id -> owner UUID mapping. Never assign one owner to all rows
-- unless that is the verified historical ownership model.

SELECT COUNT(*) AS unmapped_executions
FROM public.executions
WHERE owner_id IS NULL;

RESET ROLE;
```

5. Proceed only when `unmapped_executions = 0` and the mapping has been independently checked.
6. Run `npm run db:migrate` using the dedicated migration connection. Migration 14 rechecks the invariant before changing RLS.
7. Verify historical execution visibility for each mapped owner and verify that another owner in the same tenant cannot read those records.

If historical ownership cannot be established, stop the upgrade and preserve the existing tenant-scoped database. Do not bypass the guard, weaken the owner policy, or mark the migration complete.

## Safety boundary

The guard protects against accidental omission of a legacy owner mapping during the migration. It does not validate the truth of an operator-supplied mapping. The operator remains responsible for backup, evidence-based attribution, and post-migration verification. No hosted database or cloud resource is modified by this procedure.
