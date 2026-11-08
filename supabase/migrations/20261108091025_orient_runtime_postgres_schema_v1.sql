-- ORIENT runtime PostgreSQL schema.
-- Applied to Supabase project ORIENT (eu-central-1).
-- Runtime tables are private to the trusted backend: RLS is enabled and no
-- Data API roles receive table or sequence privileges.

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.executions (
  execution_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_tenant_updated ON public.executions(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_tenant_goal ON public.executions(tenant_id, ((payload->>'goalId')));

CREATE TABLE IF NOT EXISTS public.events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  execution_id TEXT,
  goal_id TEXT,
  type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tenant_execution ON public.events(tenant_id, execution_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_goal ON public.events(tenant_id, goal_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_type ON public.events(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_events_tenant_timestamp ON public.events(tenant_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_tenant_execution_timestamp ON public.events(tenant_id, execution_id, timestamp);

CREATE TABLE IF NOT EXISTS public.idempotency (
  key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_tenant ON public.idempotency(tenant_id);

CREATE TABLE IF NOT EXISTS public.checkpoints (
  execution_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  checkpoint_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  PRIMARY KEY (execution_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_tenant_execution ON public.checkpoints(tenant_id, execution_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_latest ON public.checkpoints(execution_id, sequence DESC);

CREATE TABLE IF NOT EXISTS public.execution_resume_leases (
  execution_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_resume_leases_expiry ON public.execution_resume_leases(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS public.workflows (
  workflow_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant_state ON public.workflows(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_workflows_approval_execution
  ON public.workflows(tenant_id, ((payload->'metadata'->>'approvalExecutionId')))
  WHERE payload->'metadata'->>'approvalBlocked'='true';

CREATE SEQUENCE IF NOT EXISTS public.workflow_lease_fencing_seq;
CREATE TABLE IF NOT EXISTS public.workflow_leases (
  workflow_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  fencing_token BIGINT NOT NULL DEFAULT nextval('public.workflow_lease_fencing_seq'),
  worker_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_leases_fencing ON public.workflow_leases(fencing_token);
CREATE INDEX IF NOT EXISTS idx_workflow_leases_expiry ON public.workflow_leases(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS public.approvals (
  approval_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  plan_revision INTEGER NOT NULL,
  tool TEXT NOT NULL,
  capability TEXT NOT NULL,
  scope JSONB NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  metadata JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_execution ON public.approvals(tenant_id, execution_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_expiry ON public.approvals(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS public.worker_nodes (
  tenant_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_nodes_tenant_heartbeat ON public.worker_nodes(tenant_id, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_worker_nodes_tenant_expiry ON public.worker_nodes(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS public.tenant_quota_limits (
  tenant_id TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL,
  max_queued INTEGER NOT NULL,
  max_input_chars INTEGER NOT NULL,
  max_tool_input_chars INTEGER NOT NULL,
  max_retries INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS public.tenant_quota_reservations (
  tenant_id TEXT NOT NULL,
  workflow_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'RUNNING')),
  reserved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  fencing_token BIGINT,
  FOREIGN KEY (tenant_id) REFERENCES public.tenant_quota_limits(tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_tenant_state ON public.tenant_quota_reservations(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_expiry ON public.tenant_quota_reservations(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS public.workflow_dispatch_claims (
  tenant_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, workflow_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_claims_expiry ON public.workflow_dispatch_claims(tenant_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_claims_worker ON public.workflow_dispatch_claims(tenant_id, worker_id, expires_at);

CREATE TABLE IF NOT EXISTS public.owner_chat_messages (
  owner_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  created_at TIMESTAMPTZ NOT NULL,
  task_id TEXT,
  PRIMARY KEY (owner_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_owner_chat_messages_order ON public.owner_chat_messages(owner_id, created_at, message_id);
CREATE INDEX IF NOT EXISTS idx_owner_chat_messages_task ON public.owner_chat_messages(owner_id, task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.owner_work_profiles (
  owner_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('standard', 'read-only-audit', 'plan-only')),
  working_preferences TEXT NOT NULL CHECK (length(working_preferences) <= 4000),
  updated_at TIMESTAMPTZ NOT NULL
);

-- Keep the application's internal schema version aligned with
-- PostgresDatabase.MIGRATIONS (versions 1 through 8).
INSERT INTO public.schema_migrations(version)
VALUES (1), (2), (3), (4), (5), (6), (7), (8)
ON CONFLICT (version) DO NOTHING;

ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_resume_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_quota_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_dispatch_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_work_profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
