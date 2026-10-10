'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const AgentLoop = require('../../src/core/execution/agent-loop');
const ExecutionContext = require('../../src/core/execution/execution-context');
const WorkflowDefinition = require('../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../src/core/workflow/workflow-instance');
const AsyncWorkflowScheduler = require('../../src/core/workflow/async-workflow-scheduler');
const AsyncWorkflowWorker = require('../../src/core/workflow/async-workflow-worker');
const ProjectBuilderAgent = require('../../src/core/agent/project-builder/project-builder-agent');
const createWorkspaceTools = require('../../src/application/tools/workspace.tools');
const ProjectOperationReceiptStore = require('../../src/infrastructure/execution/project-operation-receipt-store');

function durableIdempotencyRepository() {
  const records = new Map();
  const scopedKey = (key, tenantId) => JSON.stringify([tenantId || 'local', key]);
  return {
    records,
    async begin(args) {
      const key = args.operationId;
      const storageKey = scopedKey(key, args.tenantId);
      const existing = records.get(storageKey);
      if (existing) return { created: false, key, record: { ...existing } };
      const record = {
        key,
        executionId: args.executionId,
        step: args.step,
        tool: args.tool,
        planRevision: args.planRevision,
        operationId: args.operationId,
        tenantId: args.tenantId,
        status: 'running',
        result: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null
      };
      records.set(storageKey, record);
      return { created: true, key, record: { ...record } };
    },
    async findByKey(key, { tenantId } = {}) {
      const record = records.get(scopedKey(key, tenantId));
      return record ? { ...record } : null;
    },
    async complete(key, result, { tenantId } = {}) {
      const storageKey = scopedKey(key, tenantId);
      const record = records.get(storageKey);
      if (!record) throw new Error('Idempotency record not found');
      record.status = 'completed';
      record.result = result;
      record.completedAt = new Date().toISOString();
      records.set(storageKey, record);
      return { ...record };
    },
    async fail(key, error, { tenantId } = {}) {
      const storageKey = scopedKey(key, tenantId);
      const record = records.get(storageKey);
      if (!record) return null;
      if (record.status === 'completed') return { ...record };
      record.status = 'failed';
      record.error = { code: error?.code || 'EXECUTION_FAILED', message: error?.message || String(error) };
      record.completedAt = new Date().toISOString();
      return { ...record };
    },
    async delete(key, { tenantId } = {}) {
      return records.delete(scopedKey(key, tenantId));
    }
  };
}

function makeAgentLoop(projectTool, idempotencyRepository) {
  const registry = {
    has: name => name === 'project.execute_change',
    get: name => {
      assert.equal(name, 'project.execute_change');
      return projectTool;
    },
    execute: (name, input, context) => {
      assert.equal(name, 'project.execute_change');
      return projectTool.execute(input, context);
    }
  };
  return new AgentLoop({ toolRegistry: registry, idempotencyRepository });
}

function makePlan(original, proposed) {
  return {
    intent: 'project.change.lease.recovery',
    confidence: 1,
    steps: [{
      step: 1,
      tool: 'project.execute_change',
      input: {
        changeSet: {
          changes: [{
            action: 'update',
            path: 'src/main.js',
            content: proposed,
            expectedContentSha256: crypto.createHash('sha256').update(original, 'utf8').digest('hex')
          }]
        }
      }
    }]
  };
}

function makeExecutionContext(instance, plan, tenantId) {
  const context = new ExecutionContext({
    requestId: 'request-' + instance.workflowId,
    input: 'perform project change once',
    executionId: 'execution-' + instance.workflowId,
    tenantId
  });
  context.start();
  context.setPlan(plan);
  return context;
}

test('lease loss after a verified project side effect does not duplicate the write on recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-project-lease-loss-'));
  const receiptDirectory = path.join(os.tmpdir(), 'orient-project-lease-receipts-' + crypto.randomUUID());
  const tenantId = 'tenant-project-lease-loss';
  const operationRepository = durableIdempotencyRepository();
  const receiptStore = new ProjectOperationReceiptStore({ directory: receiptDirectory });
  const workflowId = 'workflow-project-lease-loss';
  let workspaceWrites = 0;

  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const original = "const marker = 'before-lease-loss';\\nmodule.exports = marker;\\n";
    const proposed = "const marker = 'after-lease-loss';\\nmodule.exports = marker;\\n";
    await fs.writeFile(path.join(root, 'src', 'main.js'), original, 'utf8');

    const builder = new ProjectBuilderAgent({
      projectRoot: root,
      policy: { allowRead: true, allowWrite: true, allowCommands: false, allowGit: false }
    });
    const writeText = builder.workspace.writeText.bind(builder.workspace);
    builder.workspace.writeText = async (...args) => {
      workspaceWrites += 1;
      return writeText(...args);
    };
    const projectTool = createWorkspaceTools(builder, { operationReceiptStore: receiptStore })
      .find(tool => tool.name === 'project.execute_change');
    assert.ok(projectTool);

    const plan = makePlan(original, proposed);
    const definition = new WorkflowDefinition({
      id: 'orient.project.receipt.lease-loss',
      version: 1,
      name: 'Project receipt lease loss test',
      steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME', metadata: { executionMode: 'canonical-agent-runtime' } }]
    });
    const instance = new WorkflowInstance({
      definition,
      workflowId,
      tenantId,
      input: { goal: 'change workspace once' }
    });
    const scheduler = new AsyncWorkflowScheduler({
      tenantId,
      maxConcurrent: 1,
      maxQueueDepth: 10,
      leaseDurationMs: 30000,
      maxRetries: 0
    });
    await scheduler.enqueueDurable(instance);

    const realAssertCurrent = scheduler.assertCurrentAsync.bind(scheduler);
    let assertionCount = 0;
    scheduler.assertCurrentAsync = async (...args) => {
      assertionCount += 1;
      // First assertion fences entry into the step. The second simulates lease
      // loss after AgentLoop has durably recorded the verified side effect.
      if (assertionCount === 2) {
        throw Object.assign(new Error('Simulated workflow lease loss after execution'), {
          code: 'WORKFLOW_LEASE_NOT_OWNER'
        });
      }
      return realAssertCurrent(...args);
    };

    const firstLoop = makeAgentLoop(projectTool, operationRepository);
    const firstWorker = new AsyncWorkflowWorker({
      scheduler,
      workerId: 'worker-before-lease-loss',
      tenantId,
      executor: async ({ instance: leasedInstance }) => {
        const context = makeExecutionContext(leasedInstance, plan, tenantId);
        return firstLoop.run({
          plan,
          context,
          runtimeContext: { tenantId, planRevision: 1 }
        });
      }
    });

    const firstResult = await firstWorker.tick();
    assert.equal(firstResult, null, 'the worker must not persist success after losing its lease');
    assert.equal(workspaceWrites, 1);
    assert.equal(await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'), proposed);

    const storedOperation = [...operationRepository.records.values()][0];
    assert.equal(storedOperation.status, 'completed');
    const receipt = receiptStore.read({ operationId: storedOperation.operationId, tenantId });
    assert.equal(receipt.result.status, 'verified');

    // Reconstruct the workflow from its durable checkpoint after the lease loss.
    const recoveredInstance = WorkflowInstance.fromJSON(instance.toJSON());
    recoveredInstance.recoverFromLeaseLoss('WORKFLOW_LEASE_NOT_OWNER');
    await scheduler.enqueueDurable(recoveredInstance);

    // Reconstruct AgentLoop too, retaining only the durable idempotency repository.
    const secondLoop = makeAgentLoop(projectTool, operationRepository);
    const secondWorker = new AsyncWorkflowWorker({
      scheduler,
      workerId: 'worker-after-lease-loss',
      tenantId,
      executor: async ({ instance: leasedInstance }) => {
        const context = makeExecutionContext(leasedInstance, plan, tenantId);
        return secondLoop.run({
          plan,
          context,
          runtimeContext: { tenantId, planRevision: 1 }
        });
      }
    });

    const recovered = await secondWorker.tick();
    assert.ok(recovered);
    assert.equal(recovered.state, WorkflowInstance.STATES.COMPLETED);
    assert.equal(workspaceWrites, 1, 'recovery after lease loss must not rewrite the workspace');
    assert.equal(await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'), proposed);
    assert.equal([...operationRepository.records.values()][0].status, 'completed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(receiptDirectory, { recursive: true, force: true });
  }
});
