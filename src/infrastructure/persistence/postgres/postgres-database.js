const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS executions (execution_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS idx_executions_tenant_updated ON executions(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_tenant_goal ON executions(tenant_id, ((payload->>'goalId')));
CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, execution_id TEXT, goal_id TEXT, type TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_tenant_execution ON events(tenant_id, execution_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_goal ON events(tenant_id, goal_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_type ON events(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_events_tenant_timestamp ON events(tenant_id, timestamp);
CREATE TABLE IF NOT EXISTS idempotency (key TEXT NOT NULL, tenant_id TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (tenant_id,key));
CREATE INDEX IF NOT EXISTS idx_idempotency_tenant ON idempotency(tenant_id);
CREATE TABLE IF NOT EXISTS checkpoints (execution_id TEXT NOT NULL, tenant_id TEXT NOT NULL, sequence BIGINT NOT NULL, checkpoint_id TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, snapshot JSONB NOT NULL, snapshot_sha256 TEXT NOT NULL, PRIMARY KEY (execution_id, sequence));
CREATE TABLE IF NOT EXISTS execution_resume_leases (execution_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lease_id TEXT NOT NULL UNIQUE, acquired_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL); 
CREATE INDEX IF NOT EXISTS idx_execution_resume_leases_expiry ON execution_resume_leases(tenant_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_tenant_execution ON checkpoints(tenant_id, execution_id, sequence DESC);
CREATE TABLE IF NOT EXISTS workflows (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant_state ON workflows(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_workflows_approval_execution ON workflows(tenant_id, ((payload->'metadata'->>'approvalExecutionId'))) WHERE payload->'metadata'->>'approvalBlocked'='true';
CREATE SEQUENCE IF NOT EXISTS workflow_lease_fencing_seq;
CREATE TABLE IF NOT EXISTS workflow_leases (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lease_id TEXT NOT NULL UNIQUE, fencing_token BIGINT NOT NULL DEFAULT nextval('workflow_lease_fencing_seq'), worker_id TEXT NOT NULL, acquired_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_leases_fencing ON workflow_leases(fencing_token);
CREATE INDEX IF NOT EXISTS idx_workflow_leases_expiry ON workflow_leases(tenant_id, expires_at);
CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, execution_id TEXT NOT NULL, step INTEGER NOT NULL, plan_revision INTEGER NOT NULL, tool TEXT NOT NULL, capability TEXT NOT NULL, scope JSONB NOT NULL, issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN NOT NULL DEFAULT FALSE, used_at TIMESTAMPTZ, metadata JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_execution ON approvals(tenant_id, execution_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_expiry ON approvals(tenant_id, expires_at);
CREATE TABLE IF NOT EXISTS worker_nodes (
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
CREATE INDEX IF NOT EXISTS idx_worker_nodes_tenant_heartbeat ON worker_nodes(tenant_id, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_worker_nodes_tenant_expiry ON worker_nodes(tenant_id, expires_at);
CREATE TABLE IF NOT EXISTS tenant_quota_limits (tenant_id TEXT PRIMARY KEY, max_concurrent INTEGER NOT NULL, max_queued INTEGER NOT NULL, max_input_chars INTEGER NOT NULL, max_tool_input_chars INTEGER NOT NULL, max_retries INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS tenant_quota_reservations (tenant_id TEXT NOT NULL, workflow_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING')), reserved_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, fencing_token BIGINT, FOREIGN KEY (tenant_id) REFERENCES tenant_quota_limits(tenant_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_tenant_state ON tenant_quota_reservations(tenant_id,state);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_expiry ON tenant_quota_reservations(tenant_id,expires_at);
`;
const MIGRATIONS = [
  {version:1,sql:BASE_SCHEMA},
  {version:2,sql:`
    UPDATE idempotency SET tenant_id='local' WHERE tenant_id IS NULL;
    ALTER TABLE idempotency DROP CONSTRAINT IF EXISTS idempotency_pkey;
    ALTER TABLE idempotency ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE idempotency ADD CONSTRAINT idempotency_pkey PRIMARY KEY (tenant_id,key);
    ALTER TABLE checkpoints DROP CONSTRAINT IF EXISTS checkpoints_pkey;
    ALTER TABLE checkpoints ADD CONSTRAINT checkpoints_pkey PRIMARY KEY (execution_id,sequence);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_latest ON checkpoints(execution_id,sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_events_tenant_execution_timestamp ON events(tenant_id,execution_id,timestamp);
  `},
  {version:3,sql:`
    CREATE TABLE IF NOT EXISTS worker_nodes (
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
    CREATE INDEX IF NOT EXISTS idx_worker_nodes_tenant_heartbeat ON worker_nodes(tenant_id, heartbeat_at);
    CREATE INDEX IF NOT EXISTS idx_worker_nodes_tenant_expiry ON worker_nodes(tenant_id, expires_at);
  `},
  {version:4,sql:`
    CREATE TABLE IF NOT EXISTS workflow_dispatch_claims (
      tenant_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, workflow_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_claims_expiry
      ON workflow_dispatch_claims(tenant_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_claims_worker
      ON workflow_dispatch_claims(tenant_id, worker_id, expires_at);
  `},  {version:5,sql:`
    ALTER TABLE tenant_quota_reservations ADD COLUMN IF NOT EXISTS fencing_token BIGINT;
  `},
  {version:6,sql:`
    CREATE TABLE IF NOT EXISTS execution_resume_leases (
      execution_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lease_id TEXT NOT NULL UNIQUE,
      acquired_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_resume_leases_expiry
      ON execution_resume_leases(tenant_id, expires_at);
  `},
  {version:7,sql:`
    CREATE TABLE IF NOT EXISTS owner_chat_messages (
      owner_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
      created_at TIMESTAMPTZ NOT NULL,
      task_id TEXT,
      PRIMARY KEY (owner_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_owner_chat_messages_order
      ON owner_chat_messages(owner_id, created_at, message_id);
    CREATE INDEX IF NOT EXISTS idx_owner_chat_messages_task
      ON owner_chat_messages(owner_id, task_id) WHERE task_id IS NOT NULL;
  `},

  {version:8,sql:`
    CREATE TABLE IF NOT EXISTS owner_work_profiles (
      owner_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('standard','read-only-audit','plan-only')),
      working_preferences TEXT NOT NULL CHECK (length(working_preferences) <= 4000),
      updated_at TIMESTAMPTZ NOT NULL
    );
  `},

  {version:9,sql:`
    DO $roles$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orient_owner') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orient_runtime') THEN
        RAISE EXCEPTION 'ORIENT roles missing; run scripts/provision-postgres-roles.js first';
      END IF;
    END $roles$;
    DO $policies$ DECLARE t TEXT; BEGIN
      FOREACH t IN ARRAY ARRAY['executions','events','idempotency','checkpoints','execution_resume_leases','workflows','workflow_leases','workflow_dispatch_claims','approvals','worker_nodes','tenant_quota_limits','tenant_quota_reservations'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY orient_tenant_scope ON public.%I TO orient_runtime USING (tenant_id = current_setting(''app.orient_tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.orient_tenant_id'', true))', t);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t); END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t); END IF;
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO orient_runtime', t);
      END LOOP;
      FOREACH t IN ARRAY ARRAY['owner_chat_messages','owner_work_profiles'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY orient_owner_scope ON public.%I TO orient_runtime USING (owner_id = current_setting(''app.orient_owner_id'', true)) WITH CHECK (owner_id = current_setting(''app.orient_owner_id'', true))', t);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t); END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t); END IF;
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO orient_runtime', t);
      END LOOP;
    END $policies$;
    GRANT USAGE ON SCHEMA public TO orient_runtime;
    DO $metadata$
    BEGIN
      EXECUTE 'REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC';
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.schema_migrations FROM anon'; END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.schema_migrations FROM authenticated'; END IF;
    END
    $metadata$;
    GRANT SELECT ON TABLE public.schema_migrations TO orient_runtime;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.schema_migrations FROM orient_runtime;
    GRANT USAGE, SELECT ON SEQUENCE public.workflow_lease_fencing_seq TO orient_runtime;
  `},
  {version:10,sql:`
    CREATE TABLE IF NOT EXISTS gateway_challenges (
      challenge_id UUID PRIMARY KEY,
      owner_id UUID NOT NULL,
      session_id UUID NOT NULL,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      operation_id UUID NOT NULL,
      request_id UUID NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ISSUED','CONSUMED')),
      issued_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      CHECK ((status = 'ISSUED' AND consumed_at IS NULL) OR (status = 'CONSUMED' AND consumed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_challenges_scope_expiry
      ON gateway_challenges(tenant_id, owner_id, session_id, expires_at);
    CREATE TABLE IF NOT EXISTS gateway_idempotency (
      tenant_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint CHAR(64) NOT NULL,
      owner_id UUID NOT NULL,
      session_id UUID NOT NULL,
      challenge_id UUID NOT NULL REFERENCES gateway_challenges(challenge_id),
      operation TEXT NOT NULL,
      operation_id UUID NOT NULL,
      request_id UUID NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED')),
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, idempotency_key),
      UNIQUE (tenant_id, challenge_id),
      CHECK ((status = 'RUNNING' AND response IS NULL AND completed_at IS NULL) OR
             (status = 'COMPLETED' AND response IS NOT NULL AND completed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_idempotency_owner_created
      ON gateway_idempotency(tenant_id, owner_id, created_at DESC);
    ALTER TABLE gateway_challenges ENABLE ROW LEVEL SECURITY;
    CREATE POLICY orient_gateway_challenge_scope ON gateway_challenges TO orient_runtime
      USING (tenant_id = current_setting('app.orient_tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.orient_tenant_id', true));
    ALTER TABLE gateway_idempotency ENABLE ROW LEVEL SECURITY;
    CREATE POLICY orient_gateway_idempotency_scope ON gateway_idempotency TO orient_runtime
      USING (tenant_id = current_setting('app.orient_tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.orient_tenant_id', true));
    REVOKE ALL ON TABLE gateway_challenges, gateway_idempotency FROM PUBLIC;
    DO $gateway_grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON TABLE public.gateway_challenges, public.gateway_idempotency FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON TABLE public.gateway_challenges, public.gateway_idempotency FROM authenticated';
      END IF;
    END
    $gateway_grants$;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE gateway_challenges, gateway_idempotency TO orient_runtime;
  `},
  {version:11,sql:`
    ALTER TABLE gateway_challenges ADD COLUMN request_fingerprint CHAR(64);
    UPDATE gateway_challenges
      SET request_fingerprint=repeat('0',64), expires_at=LEAST(expires_at,NOW())
      WHERE request_fingerprint IS NULL;
    ALTER TABLE gateway_challenges ALTER COLUMN request_fingerprint SET NOT NULL;
    ALTER TABLE gateway_challenges ADD CONSTRAINT gateway_challenges_request_fingerprint_format
      CHECK (length(request_fingerprint) = 64 AND request_fingerprint ~ '^[a-f0-9]{64}');
  `},
  {version:12,sql:`
    DROP POLICY IF EXISTS orient_gateway_challenge_scope ON public.gateway_challenges;
    CREATE POLICY orient_gateway_challenge_scope ON public.gateway_challenges TO orient_runtime
      USING (
        tenant_id = current_setting('app.orient_tenant_id', true)
        AND owner_id::text = current_setting('app.orient_owner_id', true)
        AND session_id::text = current_setting('app.orient_session_id', true)
      )
      WITH CHECK (
        tenant_id = current_setting('app.orient_tenant_id', true)
        AND owner_id::text = current_setting('app.orient_owner_id', true)
        AND session_id::text = current_setting('app.orient_session_id', true)
      );
    DROP POLICY IF EXISTS orient_gateway_idempotency_scope ON public.gateway_idempotency;
    CREATE POLICY orient_gateway_idempotency_scope ON public.gateway_idempotency TO orient_runtime
      USING (
        tenant_id = current_setting('app.orient_tenant_id', true)
        AND owner_id::text = current_setting('app.orient_owner_id', true)
        AND session_id::text = current_setting('app.orient_session_id', true)
      )
      WITH CHECK (
        tenant_id = current_setting('app.orient_tenant_id', true)
        AND owner_id::text = current_setting('app.orient_owner_id', true)
        AND session_id::text = current_setting('app.orient_session_id', true)
      );
  `},
  {version:13,sql:`
    CREATE TABLE IF NOT EXISTS execution_evidence (
      tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
      execution_id TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 256),
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      evidence_id TEXT NOT NULL CHECK (evidence_id ~ '^ev_[a-f0-9]{64} {
  constructor({pool,schema=null}={}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool with query(sql, params) is required');
    this.pool=pool; this.schema=schema;
    this.contextStorage = new AsyncLocalStorage();
    this.savepointCounter = 0;
  }
  async initialize() {
    const exists = await this.pool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS ready"
    );
    if (!exists.rows[0]?.ready) {
      throw Object.assign(
        new Error('PostgreSQL schema is not installed. Run the explicit database migration command before starting ORIENT.'),
        { code: 'PERSISTENCE_SCHEMA_NOT_READY' }
      );
    }

    const current = await this.pool.query(
      'SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations'
    );
    const version = Number(current.rows[0]?.version || 0);
    const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
    if (version < latest) {
      throw Object.assign(
        new Error(`PostgreSQL schema is outdated (version ${version}; expected ${latest}). Run the explicit database migration command.`),
        { code: 'PERSISTENCE_SCHEMA_OUTDATED', currentVersion: version, expectedVersion: latest }
      );
    }

    return { schemaVersion: version };
  }

  async migrate({ role = null } = {}) {
    const client=await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      if (role !== null) {
        if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(role)) throw new TypeError('Invalid PostgreSQL migration role name');
        // Keep the elevated migration identity transaction-local so a pooled
        // connection can never return to the pool still running as orient_owner.
        await client.query('SET LOCAL ROLE ' + role);
      }
      await client.query('SELECT pg_advisory_xact_lock($1)',[1407827128]);
      await client.query(BASE_SCHEMA);
      const current=await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations');
      const version=Number(current.rows[0].version);
      if(version===0){
        for(const migration of MIGRATIONS.filter(m=>m.version>1)){
          await client.query(migration.sql);
        }
        for (const migration of MIGRATIONS) await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
      } else {
        for(const migration of MIGRATIONS.filter(m=>m.version>version)){
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
        }
      }
      await client.query('COMMIT');
      return { schemaVersion: Math.max(...MIGRATIONS.map(migration => migration.version)) };
    } catch(error){
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  validatePrincipal(principal) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!principal || !['orient-owner-session', 'orient-runtime-owner'].includes(principal.authSource) ||
        typeof principal.ownerId !== 'string' || !uuid.test(principal.ownerId) ||
        principal.principalId !== principal.ownerId ||
        typeof principal.sessionId !== 'string' || !uuid.test(principal.sessionId) ||
        typeof principal.tenantId !== 'string' || !principal.tenantId.trim() || principal.tenantId.length > 128 ||
        typeof principal.workspaceId !== 'string' || !principal.workspaceId.trim() || principal.workspaceId.length > 128) {
      throw Object.assign(new Error('A verified ORIENT owner principal is required for a scoped PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_INVALID' });
    }
    return Object.freeze({ principalId: principal.principalId, ownerId: principal.ownerId, tenantId: principal.tenantId, workspaceId: principal.workspaceId, sessionId: principal.sessionId, authSource: principal.authSource });
  }

  async withPrincipal(principal, work) {
    if (typeof work !== 'function') throw new TypeError('work callback is required');
    const verifiedPrincipal = this.validatePrincipal(principal);
    const active = this.contextStorage.getStore();
    if (active) {
      const current = active.principal;
      if (current.principalId !== verifiedPrincipal.principalId || current.tenantId !== verifiedPrincipal.tenantId || current.workspaceId !== verifiedPrincipal.workspaceId || current.sessionId !== verifiedPrincipal.sessionId) {
        throw Object.assign(new Error('Cannot change ORIENT principal inside an active PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_SWITCH_REJECTED' });
      }
      return work();
    }

    const client = await this.pool.connect();
    const context = { client, principal: verifiedPrincipal, poisoned: null };
    let releaseError = null;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.orient_principal_id', $1, true), set_config('app.orient_owner_id', $2, true), set_config('app.orient_tenant_id', $3, true), set_config('app.orient_workspace_id', $4, true), set_config('app.orient_session_id', $5, true)",
        [verifiedPrincipal.principalId, verifiedPrincipal.ownerId, verifiedPrincipal.tenantId, verifiedPrincipal.workspaceId, verifiedPrincipal.sessionId]
      );
      const result = await this.contextStorage.run(context, () => work());
      if (context.poisoned) {
        throw Object.assign(
          new Error('A nested PostgreSQL savepoint could not be rolled back; the outer transaction cannot commit.'),
          { code: 'PERSISTENCE_TRANSACTION_CLEANUP_FAILED', cause: context.poisoned }
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }

  async query(text, values = []) {
    const active = this.contextStorage.getStore();
    return active ? active.client.query(text, values) : this.pool.query(text, values);
  }

  async transaction(work) {
    const active = this.contextStorage.getStore();
    if (active) {
      const savepoint = 'orient_nested_' + (++this.savepointCounter);
      await active.client.query('SAVEPOINT ' + savepoint);
      try {
        const result = await work(active.client);
        await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        try {
          await active.client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
          await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        } catch (rollbackError) {
          active.poisoned = rollbackError;
        }
        throw error;
      }
    }
    const client = await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  static json(value){return value===undefined?null:value;}
  static uuid(){return crypto.randomUUID();}
}
module.exports={PostgresDatabase,BASE_SCHEMA,MIGRATIONS,SCHEMA:BASE_SCHEMA};
),
      previous_hash CHAR(64),
      record_hash CHAR(64) NOT NULL CHECK (record_hash ~ '^[a-f0-9]{64} {
  constructor({pool,schema=null}={}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool with query(sql, params) is required');
    this.pool=pool; this.schema=schema;
    this.contextStorage = new AsyncLocalStorage();
    this.savepointCounter = 0;
  }
  async initialize() {
    const exists = await this.pool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS ready"
    );
    if (!exists.rows[0]?.ready) {
      throw Object.assign(
        new Error('PostgreSQL schema is not installed. Run the explicit database migration command before starting ORIENT.'),
        { code: 'PERSISTENCE_SCHEMA_NOT_READY' }
      );
    }

    const current = await this.pool.query(
      'SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations'
    );
    const version = Number(current.rows[0]?.version || 0);
    const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
    if (version < latest) {
      throw Object.assign(
        new Error(`PostgreSQL schema is outdated (version ${version}; expected ${latest}). Run the explicit database migration command.`),
        { code: 'PERSISTENCE_SCHEMA_OUTDATED', currentVersion: version, expectedVersion: latest }
      );
    }

    return { schemaVersion: version };
  }

  async migrate({ role = null } = {}) {
    const client=await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      if (role !== null) {
        if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(role)) throw new TypeError('Invalid PostgreSQL migration role name');
        // Keep the elevated migration identity transaction-local so a pooled
        // connection can never return to the pool still running as orient_owner.
        await client.query('SET LOCAL ROLE ' + role);
      }
      await client.query('SELECT pg_advisory_xact_lock($1)',[1407827128]);
      await client.query(BASE_SCHEMA);
      const current=await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations');
      const version=Number(current.rows[0].version);
      if(version===0){
        for(const migration of MIGRATIONS.filter(m=>m.version>1)){
          await client.query(migration.sql);
        }
        for (const migration of MIGRATIONS) await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
      } else {
        for(const migration of MIGRATIONS.filter(m=>m.version>version)){
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
        }
      }
      await client.query('COMMIT');
      return { schemaVersion: Math.max(...MIGRATIONS.map(migration => migration.version)) };
    } catch(error){
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  validatePrincipal(principal) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!principal || !['orient-owner-session', 'orient-runtime-owner'].includes(principal.authSource) ||
        typeof principal.ownerId !== 'string' || !uuid.test(principal.ownerId) ||
        principal.principalId !== principal.ownerId ||
        typeof principal.sessionId !== 'string' || !uuid.test(principal.sessionId) ||
        typeof principal.tenantId !== 'string' || !principal.tenantId.trim() || principal.tenantId.length > 128 ||
        typeof principal.workspaceId !== 'string' || !principal.workspaceId.trim() || principal.workspaceId.length > 128) {
      throw Object.assign(new Error('A verified ORIENT owner principal is required for a scoped PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_INVALID' });
    }
    return Object.freeze({ principalId: principal.principalId, ownerId: principal.ownerId, tenantId: principal.tenantId, workspaceId: principal.workspaceId, sessionId: principal.sessionId, authSource: principal.authSource });
  }

  async withPrincipal(principal, work) {
    if (typeof work !== 'function') throw new TypeError('work callback is required');
    const verifiedPrincipal = this.validatePrincipal(principal);
    const active = this.contextStorage.getStore();
    if (active) {
      const current = active.principal;
      if (current.principalId !== verifiedPrincipal.principalId || current.tenantId !== verifiedPrincipal.tenantId || current.workspaceId !== verifiedPrincipal.workspaceId || current.sessionId !== verifiedPrincipal.sessionId) {
        throw Object.assign(new Error('Cannot change ORIENT principal inside an active PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_SWITCH_REJECTED' });
      }
      return work();
    }

    const client = await this.pool.connect();
    const context = { client, principal: verifiedPrincipal, poisoned: null };
    let releaseError = null;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.orient_principal_id', $1, true), set_config('app.orient_owner_id', $2, true), set_config('app.orient_tenant_id', $3, true), set_config('app.orient_workspace_id', $4, true), set_config('app.orient_session_id', $5, true)",
        [verifiedPrincipal.principalId, verifiedPrincipal.ownerId, verifiedPrincipal.tenantId, verifiedPrincipal.workspaceId, verifiedPrincipal.sessionId]
      );
      const result = await this.contextStorage.run(context, () => work());
      if (context.poisoned) {
        throw Object.assign(
          new Error('A nested PostgreSQL savepoint could not be rolled back; the outer transaction cannot commit.'),
          { code: 'PERSISTENCE_TRANSACTION_CLEANUP_FAILED', cause: context.poisoned }
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }

  async query(text, values = []) {
    const active = this.contextStorage.getStore();
    return active ? active.client.query(text, values) : this.pool.query(text, values);
  }

  async transaction(work) {
    const active = this.contextStorage.getStore();
    if (active) {
      const savepoint = 'orient_nested_' + (++this.savepointCounter);
      await active.client.query('SAVEPOINT ' + savepoint);
      try {
        const result = await work(active.client);
        await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        try {
          await active.client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
          await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        } catch (rollbackError) {
          active.poisoned = rollbackError;
        }
        throw error;
      }
    }
    const client = await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  static json(value){return value===undefined?null:value;}
  static uuid(){return crypto.randomUUID();}
}
module.exports={PostgresDatabase,BASE_SCHEMA,MIGRATIONS,SCHEMA:BASE_SCHEMA};
),
      key_id TEXT NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127} {
  constructor({pool,schema=null}={}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool with query(sql, params) is required');
    this.pool=pool; this.schema=schema;
    this.contextStorage = new AsyncLocalStorage();
    this.savepointCounter = 0;
  }
  async initialize() {
    const exists = await this.pool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS ready"
    );
    if (!exists.rows[0]?.ready) {
      throw Object.assign(
        new Error('PostgreSQL schema is not installed. Run the explicit database migration command before starting ORIENT.'),
        { code: 'PERSISTENCE_SCHEMA_NOT_READY' }
      );
    }

    const current = await this.pool.query(
      'SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations'
    );
    const version = Number(current.rows[0]?.version || 0);
    const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
    if (version < latest) {
      throw Object.assign(
        new Error(`PostgreSQL schema is outdated (version ${version}; expected ${latest}). Run the explicit database migration command.`),
        { code: 'PERSISTENCE_SCHEMA_OUTDATED', currentVersion: version, expectedVersion: latest }
      );
    }

    return { schemaVersion: version };
  }

  async migrate({ role = null } = {}) {
    const client=await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      if (role !== null) {
        if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(role)) throw new TypeError('Invalid PostgreSQL migration role name');
        // Keep the elevated migration identity transaction-local so a pooled
        // connection can never return to the pool still running as orient_owner.
        await client.query('SET LOCAL ROLE ' + role);
      }
      await client.query('SELECT pg_advisory_xact_lock($1)',[1407827128]);
      await client.query(BASE_SCHEMA);
      const current=await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations');
      const version=Number(current.rows[0].version);
      if(version===0){
        for(const migration of MIGRATIONS.filter(m=>m.version>1)){
          await client.query(migration.sql);
        }
        for (const migration of MIGRATIONS) await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
      } else {
        for(const migration of MIGRATIONS.filter(m=>m.version>version)){
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
        }
      }
      await client.query('COMMIT');
      return { schemaVersion: Math.max(...MIGRATIONS.map(migration => migration.version)) };
    } catch(error){
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  validatePrincipal(principal) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!principal || !['orient-owner-session', 'orient-runtime-owner'].includes(principal.authSource) ||
        typeof principal.ownerId !== 'string' || !uuid.test(principal.ownerId) ||
        principal.principalId !== principal.ownerId ||
        typeof principal.sessionId !== 'string' || !uuid.test(principal.sessionId) ||
        typeof principal.tenantId !== 'string' || !principal.tenantId.trim() || principal.tenantId.length > 128 ||
        typeof principal.workspaceId !== 'string' || !principal.workspaceId.trim() || principal.workspaceId.length > 128) {
      throw Object.assign(new Error('A verified ORIENT owner principal is required for a scoped PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_INVALID' });
    }
    return Object.freeze({ principalId: principal.principalId, ownerId: principal.ownerId, tenantId: principal.tenantId, workspaceId: principal.workspaceId, sessionId: principal.sessionId, authSource: principal.authSource });
  }

  async withPrincipal(principal, work) {
    if (typeof work !== 'function') throw new TypeError('work callback is required');
    const verifiedPrincipal = this.validatePrincipal(principal);
    const active = this.contextStorage.getStore();
    if (active) {
      const current = active.principal;
      if (current.principalId !== verifiedPrincipal.principalId || current.tenantId !== verifiedPrincipal.tenantId || current.workspaceId !== verifiedPrincipal.workspaceId || current.sessionId !== verifiedPrincipal.sessionId) {
        throw Object.assign(new Error('Cannot change ORIENT principal inside an active PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_SWITCH_REJECTED' });
      }
      return work();
    }

    const client = await this.pool.connect();
    const context = { client, principal: verifiedPrincipal, poisoned: null };
    let releaseError = null;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.orient_principal_id', $1, true), set_config('app.orient_owner_id', $2, true), set_config('app.orient_tenant_id', $3, true), set_config('app.orient_workspace_id', $4, true), set_config('app.orient_session_id', $5, true)",
        [verifiedPrincipal.principalId, verifiedPrincipal.ownerId, verifiedPrincipal.tenantId, verifiedPrincipal.workspaceId, verifiedPrincipal.sessionId]
      );
      const result = await this.contextStorage.run(context, () => work());
      if (context.poisoned) {
        throw Object.assign(
          new Error('A nested PostgreSQL savepoint could not be rolled back; the outer transaction cannot commit.'),
          { code: 'PERSISTENCE_TRANSACTION_CLEANUP_FAILED', cause: context.poisoned }
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }

  async query(text, values = []) {
    const active = this.contextStorage.getStore();
    return active ? active.client.query(text, values) : this.pool.query(text, values);
  }

  async transaction(work) {
    const active = this.contextStorage.getStore();
    if (active) {
      const savepoint = 'orient_nested_' + (++this.savepointCounter);
      await active.client.query('SAVEPOINT ' + savepoint);
      try {
        const result = await work(active.client);
        await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        try {
          await active.client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
          await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        } catch (rollbackError) {
          active.poisoned = rollbackError;
        }
        throw error;
      }
    }
    const client = await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  static json(value){return value===undefined?null:value;}
  static uuid(){return crypto.randomUUID();}
}
module.exports={PostgresDatabase,BASE_SCHEMA,MIGRATIONS,SCHEMA:BASE_SCHEMA};
),
      signature TEXT NOT NULL CHECK (signature ~ '^[A-Za-z0-9+/]{86}== {
  constructor({pool,schema=null}={}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool with query(sql, params) is required');
    this.pool=pool; this.schema=schema;
    this.contextStorage = new AsyncLocalStorage();
    this.savepointCounter = 0;
  }
  async initialize() {
    const exists = await this.pool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS ready"
    );
    if (!exists.rows[0]?.ready) {
      throw Object.assign(
        new Error('PostgreSQL schema is not installed. Run the explicit database migration command before starting ORIENT.'),
        { code: 'PERSISTENCE_SCHEMA_NOT_READY' }
      );
    }

    const current = await this.pool.query(
      'SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations'
    );
    const version = Number(current.rows[0]?.version || 0);
    const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
    if (version < latest) {
      throw Object.assign(
        new Error(`PostgreSQL schema is outdated (version ${version}; expected ${latest}). Run the explicit database migration command.`),
        { code: 'PERSISTENCE_SCHEMA_OUTDATED', currentVersion: version, expectedVersion: latest }
      );
    }

    return { schemaVersion: version };
  }

  async migrate({ role = null } = {}) {
    const client=await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      if (role !== null) {
        if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(role)) throw new TypeError('Invalid PostgreSQL migration role name');
        // Keep the elevated migration identity transaction-local so a pooled
        // connection can never return to the pool still running as orient_owner.
        await client.query('SET LOCAL ROLE ' + role);
      }
      await client.query('SELECT pg_advisory_xact_lock($1)',[1407827128]);
      await client.query(BASE_SCHEMA);
      const current=await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations');
      const version=Number(current.rows[0].version);
      if(version===0){
        for(const migration of MIGRATIONS.filter(m=>m.version>1)){
          await client.query(migration.sql);
        }
        for (const migration of MIGRATIONS) await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
      } else {
        for(const migration of MIGRATIONS.filter(m=>m.version>version)){
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
        }
      }
      await client.query('COMMIT');
      return { schemaVersion: Math.max(...MIGRATIONS.map(migration => migration.version)) };
    } catch(error){
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  validatePrincipal(principal) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!principal || !['orient-owner-session', 'orient-runtime-owner'].includes(principal.authSource) ||
        typeof principal.ownerId !== 'string' || !uuid.test(principal.ownerId) ||
        principal.principalId !== principal.ownerId ||
        typeof principal.sessionId !== 'string' || !uuid.test(principal.sessionId) ||
        typeof principal.tenantId !== 'string' || !principal.tenantId.trim() || principal.tenantId.length > 128 ||
        typeof principal.workspaceId !== 'string' || !principal.workspaceId.trim() || principal.workspaceId.length > 128) {
      throw Object.assign(new Error('A verified ORIENT owner principal is required for a scoped PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_INVALID' });
    }
    return Object.freeze({ principalId: principal.principalId, ownerId: principal.ownerId, tenantId: principal.tenantId, workspaceId: principal.workspaceId, sessionId: principal.sessionId, authSource: principal.authSource });
  }

  async withPrincipal(principal, work) {
    if (typeof work !== 'function') throw new TypeError('work callback is required');
    const verifiedPrincipal = this.validatePrincipal(principal);
    const active = this.contextStorage.getStore();
    if (active) {
      const current = active.principal;
      if (current.principalId !== verifiedPrincipal.principalId || current.tenantId !== verifiedPrincipal.tenantId || current.workspaceId !== verifiedPrincipal.workspaceId || current.sessionId !== verifiedPrincipal.sessionId) {
        throw Object.assign(new Error('Cannot change ORIENT principal inside an active PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_SWITCH_REJECTED' });
      }
      return work();
    }

    const client = await this.pool.connect();
    const context = { client, principal: verifiedPrincipal, poisoned: null };
    let releaseError = null;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.orient_principal_id', $1, true), set_config('app.orient_owner_id', $2, true), set_config('app.orient_tenant_id', $3, true), set_config('app.orient_workspace_id', $4, true), set_config('app.orient_session_id', $5, true)",
        [verifiedPrincipal.principalId, verifiedPrincipal.ownerId, verifiedPrincipal.tenantId, verifiedPrincipal.workspaceId, verifiedPrincipal.sessionId]
      );
      const result = await this.contextStorage.run(context, () => work());
      if (context.poisoned) {
        throw Object.assign(
          new Error('A nested PostgreSQL savepoint could not be rolled back; the outer transaction cannot commit.'),
          { code: 'PERSISTENCE_TRANSACTION_CLEANUP_FAILED', cause: context.poisoned }
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }

  async query(text, values = []) {
    const active = this.contextStorage.getStore();
    return active ? active.client.query(text, values) : this.pool.query(text, values);
  }

  async transaction(work) {
    const active = this.contextStorage.getStore();
    if (active) {
      const savepoint = 'orient_nested_' + (++this.savepointCounter);
      await active.client.query('SAVEPOINT ' + savepoint);
      try {
        const result = await work(active.client);
        await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        try {
          await active.client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
          await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        } catch (rollbackError) {
          active.poisoned = rollbackError;
        }
        throw error;
      }
    }
    const client = await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  static json(value){return value===undefined?null:value;}
  static uuid(){return crypto.randomUUID();}
}
module.exports={PostgresDatabase,BASE_SCHEMA,MIGRATIONS,SCHEMA:BASE_SCHEMA};
),
      recorded_at TIMESTAMPTZ NOT NULL,
      record_payload JSONB NOT NULL CHECK (jsonb_typeof(record_payload) = 'object'),
      PRIMARY KEY (tenant_id, execution_id, sequence),
      UNIQUE (tenant_id, execution_id, evidence_id),
      CHECK (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64} {
  constructor({pool,schema=null}={}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool with query(sql, params) is required');
    this.pool=pool; this.schema=schema;
    this.contextStorage = new AsyncLocalStorage();
    this.savepointCounter = 0;
  }
  async initialize() {
    const exists = await this.pool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS ready"
    );
    if (!exists.rows[0]?.ready) {
      throw Object.assign(
        new Error('PostgreSQL schema is not installed. Run the explicit database migration command before starting ORIENT.'),
        { code: 'PERSISTENCE_SCHEMA_NOT_READY' }
      );
    }

    const current = await this.pool.query(
      'SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations'
    );
    const version = Number(current.rows[0]?.version || 0);
    const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
    if (version < latest) {
      throw Object.assign(
        new Error(`PostgreSQL schema is outdated (version ${version}; expected ${latest}). Run the explicit database migration command.`),
        { code: 'PERSISTENCE_SCHEMA_OUTDATED', currentVersion: version, expectedVersion: latest }
      );
    }

    return { schemaVersion: version };
  }

  async migrate({ role = null } = {}) {
    const client=await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      if (role !== null) {
        if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(role)) throw new TypeError('Invalid PostgreSQL migration role name');
        // Keep the elevated migration identity transaction-local so a pooled
        // connection can never return to the pool still running as orient_owner.
        await client.query('SET LOCAL ROLE ' + role);
      }
      await client.query('SELECT pg_advisory_xact_lock($1)',[1407827128]);
      await client.query(BASE_SCHEMA);
      const current=await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations');
      const version=Number(current.rows[0].version);
      if(version===0){
        for(const migration of MIGRATIONS.filter(m=>m.version>1)){
          await client.query(migration.sql);
        }
        for (const migration of MIGRATIONS) await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
      } else {
        for(const migration of MIGRATIONS.filter(m=>m.version>version)){
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
        }
      }
      await client.query('COMMIT');
      return { schemaVersion: Math.max(...MIGRATIONS.map(migration => migration.version)) };
    } catch(error){
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  validatePrincipal(principal) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!principal || !['orient-owner-session', 'orient-runtime-owner'].includes(principal.authSource) ||
        typeof principal.ownerId !== 'string' || !uuid.test(principal.ownerId) ||
        principal.principalId !== principal.ownerId ||
        typeof principal.sessionId !== 'string' || !uuid.test(principal.sessionId) ||
        typeof principal.tenantId !== 'string' || !principal.tenantId.trim() || principal.tenantId.length > 128 ||
        typeof principal.workspaceId !== 'string' || !principal.workspaceId.trim() || principal.workspaceId.length > 128) {
      throw Object.assign(new Error('A verified ORIENT owner principal is required for a scoped PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_INVALID' });
    }
    return Object.freeze({ principalId: principal.principalId, ownerId: principal.ownerId, tenantId: principal.tenantId, workspaceId: principal.workspaceId, sessionId: principal.sessionId, authSource: principal.authSource });
  }

  async withPrincipal(principal, work) {
    if (typeof work !== 'function') throw new TypeError('work callback is required');
    const verifiedPrincipal = this.validatePrincipal(principal);
    const active = this.contextStorage.getStore();
    if (active) {
      const current = active.principal;
      if (current.principalId !== verifiedPrincipal.principalId || current.tenantId !== verifiedPrincipal.tenantId || current.workspaceId !== verifiedPrincipal.workspaceId || current.sessionId !== verifiedPrincipal.sessionId) {
        throw Object.assign(new Error('Cannot change ORIENT principal inside an active PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_SWITCH_REJECTED' });
      }
      return work();
    }

    const client = await this.pool.connect();
    const context = { client, principal: verifiedPrincipal, poisoned: null };
    let releaseError = null;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.orient_principal_id', $1, true), set_config('app.orient_owner_id', $2, true), set_config('app.orient_tenant_id', $3, true), set_config('app.orient_workspace_id', $4, true), set_config('app.orient_session_id', $5, true)",
        [verifiedPrincipal.principalId, verifiedPrincipal.ownerId, verifiedPrincipal.tenantId, verifiedPrincipal.workspaceId, verifiedPrincipal.sessionId]
      );
      const result = await this.contextStorage.run(context, () => work());
      if (context.poisoned) {
        throw Object.assign(
          new Error('A nested PostgreSQL savepoint could not be rolled back; the outer transaction cannot commit.'),
          { code: 'PERSISTENCE_TRANSACTION_CLEANUP_FAILED', cause: context.poisoned }
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }

  async query(text, values = []) {
    const active = this.contextStorage.getStore();
    return active ? active.client.query(text, values) : this.pool.query(text, values);
  }

  async transaction(work) {
    const active = this.contextStorage.getStore();
    if (active) {
      const savepoint = 'orient_nested_' + (++this.savepointCounter);
      await active.client.query('SAVEPOINT ' + savepoint);
      try {
        const result = await work(active.client);
        await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        try {
          await active.client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
          await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        } catch (rollbackError) {
          active.poisoned = rollbackError;
        }
        throw error;
      }
    }
    const client = await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  static json(value){return value===undefined?null:value;}
  static uuid(){return crypto.randomUUID();}
}
module.exports={PostgresDatabase,BASE_SCHEMA,MIGRATIONS,SCHEMA:BASE_SCHEMA};
),
      CHECK ((sequence = 1 AND previous_hash IS NULL) OR (sequence > 1 AND previous_hash IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_execution_evidence_execution_time
      ON execution_evidence(tenant_id, execution_id, recorded_at, sequence);
    ALTER TABLE execution_evidence ENABLE ROW LEVEL SECURITY;
    CREATE POLICY orient_execution_evidence_tenant_scope ON execution_evidence
      TO orient_runtime
      USING (tenant_id = current_setting('app.orient_tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.orient_tenant_id', true));
    REVOKE ALL ON TABLE execution_evidence FROM PUBLIC;
    DO $evidence_grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON TABLE public.execution_evidence FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON TABLE public.execution_evidence FROM authenticated';
      END IF;
    END
    $evidence_grants$;
    GRANT SELECT, INSERT ON TABLE execution_evidence TO orient_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE execution_evidence FROM orient_runtime;

    CREATE OR REPLACE FUNCTION public.orient_reject_execution_evidence_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'ORIENT execution evidence is append-only'
          USING ERRCODE = '55000';
      END;
      $function$;
    REVOKE ALL ON FUNCTION public.orient_reject_execution_evidence_mutation() FROM PUBLIC;
    CREATE TRIGGER execution_evidence_reject_row_mutation
      BEFORE UPDATE OR DELETE ON public.execution_evidence
      FOR EACH ROW EXECUTE FUNCTION public.orient_reject_execution_evidence_mutation();
    CREATE TRIGGER execution_evidence_reject_truncate
      BEFORE TRUNCATE ON public.execution_evidence
      FOR EACH STATEMENT EXECUTE FUNCTION public.orient_reject_execution_evidence_mutation();
  `},
];
class PostgresDatabase {
  constructor({pool,schema=null}={}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool with query(sql, params) is required');
    this.pool=pool; this.schema=schema;
    this.contextStorage = new AsyncLocalStorage();
    this.savepointCounter = 0;
  }
  async initialize() {
    const exists = await this.pool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS ready"
    );
    if (!exists.rows[0]?.ready) {
      throw Object.assign(
        new Error('PostgreSQL schema is not installed. Run the explicit database migration command before starting ORIENT.'),
        { code: 'PERSISTENCE_SCHEMA_NOT_READY' }
      );
    }

    const current = await this.pool.query(
      'SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations'
    );
    const version = Number(current.rows[0]?.version || 0);
    const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
    if (version < latest) {
      throw Object.assign(
        new Error(`PostgreSQL schema is outdated (version ${version}; expected ${latest}). Run the explicit database migration command.`),
        { code: 'PERSISTENCE_SCHEMA_OUTDATED', currentVersion: version, expectedVersion: latest }
      );
    }

    return { schemaVersion: version };
  }

  async migrate({ role = null } = {}) {
    const client=await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      if (role !== null) {
        if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(role)) throw new TypeError('Invalid PostgreSQL migration role name');
        // Keep the elevated migration identity transaction-local so a pooled
        // connection can never return to the pool still running as orient_owner.
        await client.query('SET LOCAL ROLE ' + role);
      }
      await client.query('SELECT pg_advisory_xact_lock($1)',[1407827128]);
      await client.query(BASE_SCHEMA);
      const current=await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM schema_migrations');
      const version=Number(current.rows[0].version);
      if(version===0){
        for(const migration of MIGRATIONS.filter(m=>m.version>1)){
          await client.query(migration.sql);
        }
        for (const migration of MIGRATIONS) await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
      } else {
        for(const migration of MIGRATIONS.filter(m=>m.version>version)){
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
        }
      }
      await client.query('COMMIT');
      return { schemaVersion: Math.max(...MIGRATIONS.map(migration => migration.version)) };
    } catch(error){
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  validatePrincipal(principal) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!principal || !['orient-owner-session', 'orient-runtime-owner'].includes(principal.authSource) ||
        typeof principal.ownerId !== 'string' || !uuid.test(principal.ownerId) ||
        principal.principalId !== principal.ownerId ||
        typeof principal.sessionId !== 'string' || !uuid.test(principal.sessionId) ||
        typeof principal.tenantId !== 'string' || !principal.tenantId.trim() || principal.tenantId.length > 128 ||
        typeof principal.workspaceId !== 'string' || !principal.workspaceId.trim() || principal.workspaceId.length > 128) {
      throw Object.assign(new Error('A verified ORIENT owner principal is required for a scoped PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_INVALID' });
    }
    return Object.freeze({ principalId: principal.principalId, ownerId: principal.ownerId, tenantId: principal.tenantId, workspaceId: principal.workspaceId, sessionId: principal.sessionId, authSource: principal.authSource });
  }

  async withPrincipal(principal, work) {
    if (typeof work !== 'function') throw new TypeError('work callback is required');
    const verifiedPrincipal = this.validatePrincipal(principal);
    const active = this.contextStorage.getStore();
    if (active) {
      const current = active.principal;
      if (current.principalId !== verifiedPrincipal.principalId || current.tenantId !== verifiedPrincipal.tenantId || current.workspaceId !== verifiedPrincipal.workspaceId || current.sessionId !== verifiedPrincipal.sessionId) {
        throw Object.assign(new Error('Cannot change ORIENT principal inside an active PostgreSQL transaction.'), { code: 'PERSISTENCE_PRINCIPAL_SWITCH_REJECTED' });
      }
      return work();
    }

    const client = await this.pool.connect();
    const context = { client, principal: verifiedPrincipal, poisoned: null };
    let releaseError = null;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.orient_principal_id', $1, true), set_config('app.orient_owner_id', $2, true), set_config('app.orient_tenant_id', $3, true), set_config('app.orient_workspace_id', $4, true), set_config('app.orient_session_id', $5, true)",
        [verifiedPrincipal.principalId, verifiedPrincipal.ownerId, verifiedPrincipal.tenantId, verifiedPrincipal.workspaceId, verifiedPrincipal.sessionId]
      );
      const result = await this.contextStorage.run(context, () => work());
      if (context.poisoned) {
        throw Object.assign(
          new Error('A nested PostgreSQL savepoint could not be rolled back; the outer transaction cannot commit.'),
          { code: 'PERSISTENCE_TRANSACTION_CLEANUP_FAILED', cause: context.poisoned }
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }

  async query(text, values = []) {
    const active = this.contextStorage.getStore();
    return active ? active.client.query(text, values) : this.pool.query(text, values);
  }

  async transaction(work) {
    const active = this.contextStorage.getStore();
    if (active) {
      const savepoint = 'orient_nested_' + (++this.savepointCounter);
      await active.client.query('SAVEPOINT ' + savepoint);
      try {
        const result = await work(active.client);
        await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        try {
          await active.client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
          await active.client.query('RELEASE SAVEPOINT ' + savepoint);
        } catch (rollbackError) {
          active.poisoned = rollbackError;
        }
        throw error;
      }
    }
    const client = await this.pool.connect();
    let releaseError = null;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { client.release(releaseError || undefined); }
  }
  static json(value){return value===undefined?null:value;}
  static uuid(){return crypto.randomUUID();}
}
module.exports={PostgresDatabase,BASE_SCHEMA,MIGRATIONS,SCHEMA:BASE_SCHEMA};
