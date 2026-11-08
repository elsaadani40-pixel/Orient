-- ORIENT runtime schema v9: tenant-scope owner chat and work profiles.
-- Existing v8 rows are retained and assigned to the legacy 'local' tenant.
-- The temporary defaults backfill existing rows; they are removed so future
-- writes must provide an explicit trusted tenant identifier.
BEGIN;

ALTER TABLE public.owner_chat_messages
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE public.owner_work_profiles
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'local';

ALTER TABLE public.owner_chat_messages
  ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.owner_work_profiles
  ALTER COLUMN tenant_id DROP DEFAULT;

ALTER TABLE public.owner_chat_messages
  DROP CONSTRAINT IF EXISTS owner_chat_messages_pkey;
ALTER TABLE public.owner_chat_messages
  ADD CONSTRAINT owner_chat_messages_pkey
  PRIMARY KEY (tenant_id, owner_id, message_id);

ALTER TABLE public.owner_work_profiles
  DROP CONSTRAINT IF EXISTS owner_work_profiles_pkey;
ALTER TABLE public.owner_work_profiles
  ADD CONSTRAINT owner_work_profiles_pkey
  PRIMARY KEY (tenant_id, owner_id);

DROP INDEX IF EXISTS public.idx_owner_chat_messages_order;
DROP INDEX IF EXISTS public.idx_owner_chat_messages_task;
CREATE INDEX IF NOT EXISTS idx_owner_chat_messages_tenant_order
  ON public.owner_chat_messages(tenant_id, owner_id, created_at, message_id);
CREATE INDEX IF NOT EXISTS idx_owner_chat_messages_tenant_task
  ON public.owner_chat_messages(tenant_id, owner_id, task_id)
  WHERE task_id IS NOT NULL;

INSERT INTO public.schema_migrations(version)
VALUES (9)
ON CONFLICT (version) DO NOTHING;

COMMIT;
