'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const AgentLoop = require('../../src/core/execution/agent-loop');
const ExecutionContext = require('../../src/core/execution/execution-context');
const ProjectBuilderAgent = require('../../src/core/agent/project-builder/project-builder-agent');
const createWorkspaceTools = require('../../src/application/tools/workspace.tools');
const ProjectOperationReceiptStore = require('../../src/infrastructure/execution/project-operation-receipt-store');

function crashOnceIdempotencyRepository() {
  const records = new Map();
  let crashOnComplete = true;
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
      if (crashOnComplete) {
        crashOnComplete = false;
        const error = new Error('simulated crash before local completion commit');
        error.code = 'SIMULATED_COMPLETION_CRASH';
        throw error;
      }
      record.status = 'completed';
      record.result = result;
      record.completedAt = new Date().toISOString();
      records.set(storageKey, record);
      return { ...record };
    },
    async fail(key, error, { tenantId } = {}) {
      // A real process crash cannot persist the catch-path failure update.
      // Preserve RUNNING to model the exact uncertain-outcome window.
      return records.get(scopedKey(key, tenantId)) || null;
    },
    async delete(key, { tenantId } = {}) {
      return records.delete(scopedKey(key, tenantId));
    }
  };
}

test('project operation receipt reconciles a crash after filesystem verification but before idempotency completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-project-receipt-crash-'));
  const receiptDirectory = path.join(os.tmpdir(), 'orient-project-receipts-' + crypto.randomUUID());
  const tenantId = 'tenant-receipt-crash';
  const operationRepository = crashOnceIdempotencyRepository();
  const receiptStore = new ProjectOperationReceiptStore({ directory: receiptDirectory });
  let workspaceWrites = 0;

  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const original = "const marker = 'before';\nmodule.exports = marker;\n";
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

    const tools = createWorkspaceTools(builder, { operationReceiptStore: receiptStore });
    const projectTool = tools.find(tool => tool.name === 'project.execute_change');
    assert.ok(projectTool);
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
    const loop = new AgentLoop({
      toolRegistry: registry,
      idempotencyRepository: operationRepository
    });
    const proposed = "const marker = 'after-recovery';\nmodule.exports = marker;\n";
    const plan = {
      intent: 'project.change.recovery',
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
    const firstContext = new ExecutionContext({
      requestId: 'request-project-receipt-crash',
      input: 'apply and recover a project change',
      executionId: 'execution-project-receipt-crash',
      tenantId
    });
    firstContext.start();
    firstContext.setPlan(plan);

    await assert.rejects(
      () => loop.run({ plan, context: firstContext, runtimeContext: { tenantId, planRevision: 1 } }),
      error => error.code === 'SIMULATED_COMPLETION_CRASH'
    );

    assert.equal(workspaceWrites, 1, 'the first attempt should write the workspace exactly once');
    assert.equal(await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'), proposed);
    const operationRecord = [...operationRepository.records.values()][0];
    assert.equal(operationRecord.status, 'running', 'the simulated crash must leave local completion uncommitted');

    const restored = ExecutionContext.restore(firstContext.snapshot());
    const repeatedResumeSnapshot = restored.snapshot();
    const recovered = await loop.run({
      plan,
      context: restored,
      runtimeContext: { tenantId, planRevision: 1 }
    });

    assert.equal(recovered.status, 'done');
    assert.equal(workspaceWrites, 1, 'receipt-backed recovery must not write the files again');
    assert.equal(await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'), proposed);
    assert.equal([...operationRepository.records.values()][0].status, 'completed');
    const operationId = [...operationRepository.records.values()][0].operationId;
    const receipt = receiptStore.read({ operationId, tenantId });
    assert.equal(receipt.result.status, 'verified');
    assert.equal(receipt.workspaceId, crypto.createHash('sha256').update(path.resolve(builder.policy.realAllowedRoot), 'utf8').digest('hex'));

    const repeatedResume = await loop.run({
      plan,
      context: ExecutionContext.restore(repeatedResumeSnapshot),
      runtimeContext: { tenantId, planRevision: 1 }
    });
    assert.equal(repeatedResume.status, 'done');
    assert.equal(workspaceWrites, 1, 'repeated resume must not repeat the side effect');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(receiptDirectory, { recursive: true, force: true });
  }
});
