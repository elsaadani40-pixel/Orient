-- Keep the Supabase-managed schema aligned with the runtime PostgreSQL migrations.
-- These columns bind durable dispatch claims and leases to one worker session.
ALTER TABLE public.worker_nodes
  ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT '';

ALTER TABLE public.workflow_dispatch_claims
  ADD COLUMN IF NOT EXISTS worker_session_id TEXT NOT NULL DEFAULT '';

ALTER TABLE public.workflow_leases
  ADD COLUMN IF NOT EXISTS worker_session_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_worker_nodes_tenant_session
  ON public.worker_nodes(tenant_id, worker_id, session_id);

CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_claims_worker_session
  ON public.workflow_dispatch_claims(tenant_id, worker_id, worker_session_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_workflow_leases_worker_session
  ON public.workflow_leases(tenant_id, worker_id, worker_session_id, expires_at);
