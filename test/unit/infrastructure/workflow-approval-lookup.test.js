'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqlitePersistence = require('../../../src/infrastructure/persistence/sqlite/sqlite-persistence');
const WorkflowDefinition = require('../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../src/core/workflow/workflow-instance');
const { PostgresWorkflowRepository } = require('../../../src/infrastructure/persistence/postgres/postgres-persistence');

test('SQLite approval workflow lookup is tenant-scoped', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-approval-workflow-'));
  let persistence;
  try {
    persistence = new SqlitePersistence({ filePath: path.join(directory, 'orient.db') });
    const definition = new WorkflowDefinition({
      id: 'approval-mapping',
      version: 1,
      name: 'Approval mapping',
      steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME' }]
    });
    const instance = new WorkflowInstance({
      definition,
      workflowId: 'workflow-sqlite-approval-map',
      tenantId: 'tenant-a',
      input: { text: 'guarded operation' }
    });
    instance.transition('QUEUED');
    instance.transition('RUNNING');
    instance.transition('WAITING');
    instance.metadata = {
      approvalBlocked: true,
      approvalExecutionId: 'execution-sqlite-approval-map',
      approvalId: 'approval-sqlite-map'
    };
    persistence.workflows.save(instance, 'tenant-a');

    const found = persistence.workflows.findByApprovalExecutionId({
      executionId: 'execution-sqlite-approval-map',
      tenantId: 'tenant-a'
    });
    assert.equal(found.workflowId, 'workflow-sqlite-approval-map');
    assert.equal(found.metadata.approvalId, 'approval-sqlite-map');
    assert.equal(persistence.workflows.findByApprovalExecutionId({
      executionId: 'execution-sqlite-approval-map',
      tenantId: 'tenant-other'
    }), null);
  } finally {
    persistence?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('PostgreSQL approval workflow lookup binds execution and tenant as parameters', async () => {
  const calls = [];
  const payload = {
    workflowId: 'workflow-postgres-approval-map',
    tenantId: 'tenant-a',
    metadata: { approvalBlocked: true, approvalExecutionId: 'execution-a', approvalId: 'approval-a' }
  };
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ payload }] };
    }
  };
  const repository = new PostgresWorkflowRepository(db);
  const found = await repository.findByApprovalExecutionId({
    executionId: 'execution-a',
    tenantId: 'tenant-a'
  });

  assert.equal(found.workflowId, 'workflow-postgres-approval-map');
  assert.match(calls[0].sql, /approvalBlocked/);
  assert.match(calls[0].sql, /approvalExecutionId/);
  assert.match(calls[0].sql, /tenant_id=\$2/);
  assert.deepEqual(calls[0].values, ['execution-a', 'tenant-a']);
  assert.equal(await repository.findByApprovalExecutionId({ executionId: '' }), null);
});
