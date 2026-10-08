class PostgresExecutionRepository {
  constructor(db) { this.db = db; }

  async findById(executionId, { tenantId = null } = {}) {
    const values = tenantId ? [executionId, tenantId] : [executionId];
    const where = tenantId ? 'AND tenant_id=$2' : '';
    const result = await this.db.query(
      `SELECT payload FROM executions WHERE execution_id=$1 ${where} LIMIT 1`,
      values
    );
    return result.rows.length ? result.rows[0].payload : null;
  }

  async findAll({ tenantId = null } = {}) {
    const result = tenantId
      ? await this.db.query('SELECT payload FROM executions WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId])
      : await this.db.query('SELECT payload FROM executions ORDER BY updated_at DESC');
    return result.rows.map(row => row.payload);
  }

  async findByGoalId(goalId, { tenantId = null } = {}) {
    const result = await this.db.query(tenantId ? 'SELECT payload FROM executions WHERE tenant_id=$1 AND payload->>\'goalId\'=$2 ORDER BY updated_at DESC' : 'SELECT payload FROM executions WHERE payload->>\'goalId\'=$1 ORDER BY updated_at DESC', tenantId ? [tenantId,goalId] : [goalId]); return result.rows.map(row => row.payload);
  }

  async insert(execution, { tenantId = null } = {}) {
    const generatedExecutionId = execution.id || execution.executionId || crypto.randomUUID();
    const normalized = {
      ...execution,
      id: generatedExecutionId,
      executionId: generatedExecutionId,
      executionVersion: Number(execution.executionVersion || 1),
      status: execution.status || 'created',
      agentLifecycle: execution.agentLifecycle || 'created',
      metadata: execution.metadata && typeof execution.metadata === 'object' ? { ...execution.metadata } : {},
      steps: Array.isArray(execution.steps) ? [...execution.steps] : [],
      observations: Array.isArray(execution.observations) ? [...execution.observations] : [],
      events: Array.isArray(execution.events) ? [...execution.events] : [],
      updatedAt: execution.updatedAt || new Date().toISOString()
    };
    const effectiveTenant = tenantOrLocal(normalized.tenantId || normalized.metadata.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Execution');
    normalized.tenantId = effectiveTenant;
    await this.db.query(
      'INSERT INTO executions(execution_id,tenant_id,payload,updated_at) VALUES($1,$2,$3,$4)',
      [normalized.executionId, effectiveTenant, normalized, normalized.updatedAt]
    );
    return normalized;
  }

  async update(executionId, patch, { tenantId = null } = {}) {
    const current = await this.findById(executionId, { tenantId });
    if (!current) return null;
    const effectiveTenant = tenantOrLocal(current.tenantId || current.metadata?.tenantId);
    assertTenant(effectiveTenant, tenantId, 'Execution');
    const updated = {
      ...current, ...patch,
      id: current.id,
      executionId: current.executionId,
      tenantId: effectiveTenant,
      updatedAt: new Date().toISOString()
    };
    await this.db.query(
      'UPDATE executions SET payload=$3,updated_at=$4 WHERE execution_id=$1 AND tenant_id=$2',
      [executionId, effectiveTenant, updated, updated.updatedAt]
    );
    return updated;
  }

  async requestCancellation(executionId, reason = 'Execution cancellation requested', { tenantId = null } = {}) {
    if (!executionId) throw new TypeError('executionId is required');

    const effectiveTenant = tenantId || 'local';
    const result = await this.db.query(
      `SELECT payload FROM executions WHERE execution_id=$1 AND tenant_id=$2 FOR UPDATE`,
      [executionId, effectiveTenant]
    );
    if (!result.rows.length) return null;

    const current = result.rows[0].payload || {};
    if (['completed', 'failed', 'cancelled'].includes(current.status)) return current;

    const updated = {
      ...current,
      cancellationRequested: true,
      cancellationReason: String(reason || 'Execution cancellation requested'),
      updatedAt: new Date().toISOString()
    };
