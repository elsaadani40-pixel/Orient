class PostgresTenantQuotaRepository {
  constructor(db) {
    this.db = db;
  }

  async ensureTenant(tenantId, policy) {
    if (!tenantId) throw new TypeError('tenantId is required');
    await this.db.query(
      `INSERT INTO tenant_quota_limits(tenant_id,max_concurrent,max_queued,max_input_chars,max_tool_input_chars,max_retries,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT(tenant_id) DO UPDATE SET
         max_concurrent=EXCLUDED.max_concurrent,
         max_queued=EXCLUDED.max_queued,
         max_input_chars=EXCLUDED.max_input_chars,
         max_tool_input_chars=EXCLUDED.max_tool_input_chars,
         max_retries=EXCLUDED.max_retries,
         updated_at=NOW()`,
      [tenantId,policy.maxConcurrent,policy.maxQueued,policy.maxInputChars,policy.maxToolInputChars,policy.maxRetries]
    );
  }

  async reserveWorkflow({tenantId,workflowId,policy,expiresAt=null}) {
    if (!tenantId || !workflowId) throw new TypeError('tenantId and workflowId are required');
    const result = await this.db.transaction(async client => {
      await client.query(
        `INSERT INTO tenant_quota_limits(tenant_id,max_concurrent,max_queued,max_input_chars,max_tool_input_chars,max_retries,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT(tenant_id) DO UPDATE SET
           max_concurrent=$2,max_queued=$3,max_input_chars=$4,max_tool_input_chars=$5,max_retries=$6,updated_at=NOW()`,
        [tenantId,policy.maxConcurrent,policy.maxQueued,policy.maxInputChars,policy.maxToolInputChars,policy.maxRetries]
      );
      const row = (await client.query(
        'SELECT max_concurrent,max_queued FROM tenant_quota_limits WHERE tenant_id=$1 FOR UPDATE',
        [tenantId]
      )).rows[0];
      await client.query(
        "DELETE FROM tenant_quota_reservations WHERE tenant_id=$1 AND state='QUEUED' AND expires_at IS NOT NULL AND expires_at <= NOW()",
        [tenantId]
      );
      await client.query(
        `DELETE FROM tenant_quota_reservations r
         WHERE r.tenant_id=$1
           AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.workflow_id=r.workflow_id AND w.tenant_id=r.tenant_id)`,
        [tenantId]
      );
      const existing = await client.query(
        'SELECT tenant_id,workflow_id,state,reserved_at,expires_at FROM tenant_quota_reservations WHERE tenant_id=$1 AND workflow_id=$2 LIMIT 1',
        [tenantId,workflowId]
      );
      if (existing.rowCount === 1) return existing.rows[0];
      const counts = (await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE state='RUNNING')::int AS active,
           COUNT(*) FILTER (WHERE state='QUEUED')::int AS queued
         FROM tenant_quota_reservations WHERE tenant_id=$1`,
        [tenantId]
      )).rows[0];
      // Admission is two-dimensional: maxConcurrent limits RUNNING work,
      // while maxQueued limits waiting work. A full running slot must not
      // prevent a workflow from entering the durable queue.
      if (Number(counts.queued) >= Number(row.max_queued)) {
        const error = new Error('Tenant queued workflow quota exceeded');
        error.code = 'TENANT_QUEUE_QUOTA_EXCEEDED';
        throw error;
      }
      const inserted = await client.query(
        `INSERT INTO tenant_quota_reservations(tenant_id,workflow_id,state,reserved_at,expires_at)
         VALUES($1,$2,'QUEUED',NOW(),$3)
         ON CONFLICT(workflow_id) DO NOTHING
         RETURNING tenant_id,workflow_id,state,reserved_at,expires_at`,
        [tenantId,workflowId,expiresAt]
      );
      if (inserted.rowCount !== 1) {
        const error = new Error('Workflow quota reservation already exists');
        error.code = 'TENANT_QUOTA_RESERVATION_EXISTS';
        throw error;
      }
      return inserted.rows[0];
    });
    return this.toModel(result);
  }

  async promoteWorkflow({tenantId,workflowId,expiresAt=null}) {
    const normalizedExpiresAt=expiresAt==null?null:new Date(expiresAt).toISOString();
    const result = await this.db.transaction(async client => {
      const limit = (await client.query(
        'SELECT max_concurrent FROM tenant_quota_limits WHERE tenant_id=$1 FOR UPDATE',
        [tenantId]
      )).rows[0];
      if (!limit) return null;
      await client.query(
        'DELETE FROM tenant_quota_reservations WHERE tenant_id=$1 AND expires_at IS NOT NULL AND expires_at <= NOW()',
        [tenantId]
      );
      const active = (await client.query(
        "SELECT COUNT(*)::int AS count FROM tenant_quota_reservations WHERE tenant_id=$1 AND state='RUNNING'",
        [tenantId]
      )).rows[0];
      if (Number(active.count) >= Number(limit.max_concurrent)) {
        const error = new Error('Tenant concurrent workflow quota exceeded');
        error.code = 'TENANT_CONCURRENT_QUOTA_EXCEEDED';
        throw error;
      }
      const promoted = await client.query(
        `UPDATE tenant_quota_reservations
         SET state='RUNNING',expires_at=$3
         WHERE tenant_id=$1 AND workflow_id=$2 AND state='QUEUED'
         RETURNING tenant_id,workflow_id,state,reserved_at,expires_at`,
        [tenantId,workflowId,normalizedExpiresAt]
      );
      return promoted.rowCount === 1 ? promoted.rows[0] : null;
    });
    return result ? this.toModel(result) : null;
  }

  async queueWorkflow({tenantId,workflowId,expiresAt=null}) {
    const normalizedExpiresAt=expiresAt==null?null:new Date(expiresAt).toISOString();
    const result = await this.db.query(
      `UPDATE tenant_quota_reservations
       SET state='QUEUED',expires_at=$3
       WHERE tenant_id=$1 AND workflow_id=$2
       RETURNING tenant_id,workflow_id,state,reserved_at,expires_at`,
      [tenantId,workflowId,normalizedExpiresAt]
    );
    return result.rowCount === 1 ? this.toModel(result.rows[0]) : null;
  }

  async refreshWorkflow({tenantId,workflowId,expiresAt}) {
    const normalizedExpiresAt=new Date(expiresAt).toISOString();
    const result = await this.db.query(
      `UPDATE tenant_quota_reservations
       SET expires_at=$3
       WHERE tenant_id=$1 AND workflow_id=$2 AND state='RUNNING'`,
      [tenantId,workflowId,normalizedExpiresAt]
    );
    return result.rowCount === 1;
  }

  async releaseWorkflow({tenantId,workflowId}) {
    const result = await this.db.query(
      'DELETE FROM tenant_quota_reservations WHERE tenant_id=$1 AND workflow_id=$2',
      [tenantId,workflowId]
    );
    return result.rowCount === 1;
  }

  async snapshot({tenantId}) {
    const result = await this.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE state='RUNNING')::int AS active,
         COUNT(*) FILTER (WHERE state='QUEUED')::int AS queued
       FROM tenant_quota_reservations WHERE tenant_id=$1`,
      [tenantId]
    );
    const row=result.rows[0]||{active:0,queued:0};
    return {tenantId,active:Number(row.active),queued:Number(row.queued)};
  }

  toModel(row) {
    return {
      tenantId:row.tenant_id,
      workflowId:row.workflow_id,
      state:row.state,
      reservedAt:row.reserved_at,
      expiresAt:row.expires_at
    };
  }
}

module.exports = PostgresTenantQuotaRepository;
