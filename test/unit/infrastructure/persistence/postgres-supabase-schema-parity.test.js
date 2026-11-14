'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.resolve(
  __dirname,
  '../../../../supabase/migrations/20261111120000_orient_worker_session_fencing_parity.sql'
);
const migration = fs.readFileSync(migrationPath, 'utf8');

test('Supabase schema adds the worker-session identity columns required by durable fencing', () => {
  assert.match(
    migration,
    /ALTER TABLE public\.worker_nodes\s+ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT ''/i
  );
  assert.match(
    migration,
    /ALTER TABLE public\.workflow_dispatch_claims\s+ADD COLUMN IF NOT EXISTS worker_session_id TEXT NOT NULL DEFAULT ''/i
  );
  assert.match(
    migration,
    /ALTER TABLE public\.workflow_leases\s+ADD COLUMN IF NOT EXISTS worker_session_id TEXT NOT NULL DEFAULT ''/i
  );
});

test('Supabase schema indexes exact worker-session registry, claim and lease lookups', () => {
  assert.match(
    migration,
    /idx_worker_nodes_tenant_session[\s\S]*ON public\.worker_nodes\(tenant_id, worker_id, session_id\)/i
  );
  assert.match(
    migration,
    /idx_workflow_dispatch_claims_worker_session[\s\S]*ON public\.workflow_dispatch_claims\(tenant_id, worker_id, worker_session_id, expires_at\)/i
  );
  assert.match(
    migration,
    /idx_workflow_leases_worker_session[\s\S]*ON public\.workflow_leases\(tenant_id, worker_id, worker_session_id, expires_at\)/i
  );
});
