'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AgentLoop = require('../../src/core/execution/agent-loop');
const ExecutionContext = require('../../src/core/execution/execution-context');
const WorkflowDefinition = require('../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../src/core/workflow/workflow-instance');
const AsyncWorkflowScheduler = require('../../src/core/workflow/async-workflow-scheduler');
const AsyncWorkflowWorker = require('../../src/core/workflow/async-workflow-worker');
const JsonMemoryRepository = require('../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../src/infrastructure/memory/memory-audit.repository');
const MemoryTransactionCoordinator = require('../../src/infrastructure/memory/memory-transaction-coordinator');
const MemoryService = require('../../src/application/memory/memory.service');
const createMemoryTools = require('../../src/application/tools/memory.tools');

function durableIdempotencyRepository() {
  const records = new Map();
  const scopedKey = (key, tenantId) => JSON.stringify([tenantId || 'local', key]);
  return {
    records,
    begin(args) {
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
    findByKey(key, { tenantId } = {}) {
      const record = records.get(scopedKey(key, tenantId));
      return record ? { ...record } : null;
    },
    complete(key, result, { tenantId } = {}) {
      const storageKey = scopedKey(key, tenantId);
      const record = records.get(storageKey);
      if (!record) throw new Error('Idempotency record not found');
      record.status = 'completed';
      record.result = result;
      record.completedAt = new Date().toISOString();
      records.set(storageKey, record);
      return { ...record };
    },
    fail(key, error, { tenantId } = {}) {
      const storageKey = scopedKey(key, tenantId);
      const record = records.get(storageKey);
      if (!record) return null;
      if (record.status === 'completed') return { ...record };
      record.status = 'failed';
      record.error = { code: error?.code || 'EXECUTION_FAILED', message: error?.message || String(error) };
      record.completedAt = new Date().toISOString();
      return { ...record };
    },
    delete(key, { tenantId } = {}) {
      return records.delete(scopedKey(key, tenantId));
    }
  };
}

function createMemoryService(root) {
  const memoryFile = path.join(root, 'memory.json');
  const auditFile = path.join(root, 'memory-audit.json');
  const coordinator = new MemoryTransactionCoordinator({
    memoryFile,
    auditFile,
    journalFile: path.join(root, 'memory-transaction-journal.json')
  });
  coordinator.recover();
  const repository = new JsonMemoryRepository(memoryFile);
  const auditRepository = new MemoryAuditRepository(auditFile);
  const service = new MemoryService(repository, {
    auditRepository,
    transactionCoordinator: coordinator
  });
  return { service, auditRepository, repository };
}

function makeAgentLoop(memoryTool, idempotencyRepository) {
  const registry = {
    has: name => name === 'memory.add',
    get: name => {
      assert.equal(name, 'memory.add');
      return memoryTool;
    },
    execute: (name, input, context) => {
      assert.equal(name, 'memory.add');
      return memoryTool.execute(input, context);
    }
  };
  return new AgentLoop({ toolRegistry: registry, idempotencyRepository });
}

function makePlan() {
  return {
    intent: 'memory.add.lease.recovery',
    confidence: 1,
    steps: [{
      step: 1,
      tool: 'memory.add',
      input: { text: 'memory lease loss must not duplicate', scope: 'personal' }
    }]
  };
}

function makeContext(instance, plan, tenantId) {
  const context = new ExecutionContext({
    requestId: 'request-' + instance.workflowId,
    input: 'save this memory exactly once',
    executionId: 'execution-' + instance.workflowId,
    tenantId
  });
  context.start();
  context.setPlan(plan);
  return context;
}

test('memory.add receipt and idempotency result prevent duplicate writes after workflow lease loss', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-lease-loss-'));
  const tenantId = 'tenant-memory-lease-loss';
  const operationRepository = durableIdempotencyRepository();
  const workflowId = 'workflow-memory-lease-loss';

  try {
    const initial = createMemoryService(root);
    const memoryTool = createMemoryTools(initial.service).find(tool => tool.name === 'memory.add');
    assert.ok(memoryTool);
    const plan = makePlan();
    const definition = new WorkflowDefinition({
      id: 'orient.memory.receipt.lease-loss',
      version: 1,
      name: 'Memory receipt lease loss test',
      steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME', metadata: { executionMode: 'canonical-agent-runtime' } }]
    });
    const instance = new WorkflowInstance({
      definition,
      workflowId,
      tenantId,
      input: { goal: 'store one memory' }
    });
    const scheduler = new AsyncWorkflowScheduler({
      tenantId,
      maxConcurrent: 1,
      maxQueueDepth: 10,
      leaseDurationMs: 30000,
      maxRetries: 0
    });
    await scheduler.enqueueDurable(instance);

    const leaseAsync = scheduler.leaseAsync.bind(scheduler);
    scheduler.leaseAsync = async (...args) => {
      const lease = await leaseAsync(...args);
      if (lease) {
        lease.fencingToken = 1;
        scheduler.active.get(lease.workflowId).fencingToken = 1;
      }
      return lease;
    };
    let assertionCount = 0;
    scheduler.assertCurrentAsync = async () => {
      assertionCount += 1;
      if (assertionCount === 2) {
        throw Object.assign(new Error('Simulated workflow lease loss after memory commit'), {
          code: 'WORKFLOW_LEASE_NOT_OWNER'
        });
      }
      return true;
    };

    const firstLoop = makeAgentLoop(memoryTool, operationRepository);
    const firstWorker = new AsyncWorkflowWorker({
      scheduler,
      workerId: 'memory-worker-before-lease-loss',
      tenantId,
      executor: async ({ instance: leasedInstance }) => firstLoop.run({
        plan,
        context: makeContext(leasedInstance, plan, tenantId),
        runtimeContext: { tenantId, memoryScope: 'personal', planRevision: 1 }
      })
    });
    // The worker API returns the current workflow instance even when the lease is lost;
    // the durable operation receipt, not a null return value, is the recovery contract.
    assert.ok(await firstWorker.tick());
    const operationRecord = [...operationRepository.records.values()][0];
    assert.equal(operationRecord.status, 'completed');
    assert.equal(initial.auditRepository.findByOperationId(
      operationRecord.operationId, tenantId, 'personal'
    ).length, 1);

    const recoveredInstance = WorkflowInstance.fromJSON(instance.toJSON());
    recoveredInstance.recoverFromLeaseLoss('WORKFLOW_LEASE_NOT_OWNER');
    await scheduler.enqueueDurable(recoveredInstance);

    // Reconstruct the adapter and AgentLoop while retaining the durable operation ledger.
    const restarted = createMemoryService(root);
    const restartedMemoryTool = createMemoryTools(restarted.service).find(tool => tool.name === 'memory.add');
    const secondLoop = makeAgentLoop(restartedMemoryTool, operationRepository);
    const secondWorker = new AsyncWorkflowWorker({
      scheduler,
      workerId: 'memory-worker-after-lease-loss',
      tenantId,
      executor: async ({ instance: leasedInstance }) => secondLoop.run({
        plan,
        context: makeContext(leasedInstance, plan, tenantId),
        runtimeContext: { tenantId, memoryScope: 'personal', planRevision: 1 }
      })
    });

    const recovered = await secondWorker.tick();
    assert.ok(recovered);
    assert.equal(recovered.state, WorkflowInstance.STATES.COMPLETED);
    assert.equal(operationRepository.records.size, 1);
    const receipts = restarted.auditRepository.findByOperationId(
      operationRecord.operationId, tenantId, 'personal'
    );
    assert.equal(receipts.length, 1, 'lease recovery must not create a second memory audit receipt');
    assert.equal(receipts[0].action, 'memory.created');
    const reconciled = restarted.service.reconcileToolOperation('memory.add', {
      text: 'memory lease loss must not duplicate',
      scope: 'personal'
    }, {
      tenantId,
      memoryScope: 'personal',
      operationId: operationRecord.operationId
    });
    assert.equal(reconciled.status, 'completed');
    assert.equal(reconciled.result.id, operationRecord.result.id);
    assert.equal(restarted.auditRepository.findByOperationId(
      operationRecord.operationId, 'other-tenant', 'personal'
    ).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


function makeDeleteAgentLoop(memoryTool, idempotencyRepository) {
  const registry = {
    has: name => name === 'memory.delete',
    get: name => {
      assert.equal(name, 'memory.delete');
      return memoryTool;
    },
    execute: (name, input, context) => {
      assert.equal(name, 'memory.delete');
      return memoryTool.execute(input, context);
    }
  };
  return new AgentLoop({ toolRegistry: registry, idempotencyRepository });
}

test('memory.delete archive receipt prevents duplicate deletion after workflow lease loss', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-delete-lease-loss-'));
  const tenantId = 'tenant-memory-delete-lease-loss';
  const operationRepository = durableIdempotencyRepository();
  const workflowId = 'workflow-memory-delete-lease-loss';

  try {
    const initial = createMemoryService(root);
    const seeded = initial.service.add('memory target for lease-loss delete', {}, {
      tenantId,
      memoryScope: 'personal',
      operationId: 'seed-delete-target'
    });
    const memoryTool = createMemoryTools(initial.service).find(tool => tool.name === 'memory.delete');
    assert.ok(memoryTool);
    const plan = {
      intent: 'memory.delete.lease.recovery',
      confidence: 1,
      steps: [{
        step: 1,
        tool: 'memory.delete',
        input: { id: seeded.id, scope: 'personal' }
      }]
    };
    const definition = new WorkflowDefinition({
      id: 'orient.memory.delete.receipt.lease-loss',
      version: 1,
      name: 'Memory delete receipt lease loss test',
      steps: [{ id: 'agent-runtime', agent: 'ORIENT_RUNTIME', metadata: { executionMode: 'canonical-agent-runtime' } }]
    });
    const instance = new WorkflowInstance({
      definition,
      workflowId,
      tenantId,
      input: { goal: 'delete one memory' }
    });
    const scheduler = new AsyncWorkflowScheduler({
      tenantId,
      maxConcurrent: 1,
      maxQueueDepth: 10,
      leaseDurationMs: 30000,
      maxRetries: 0
    });
    await scheduler.enqueueDurable(instance);

    const leaseAsync = scheduler.leaseAsync.bind(scheduler);
    scheduler.leaseAsync = async (...args) => {
      const lease = await leaseAsync(...args);
      if (lease) {
        lease.fencingToken = 1;
        scheduler.active.get(lease.workflowId).fencingToken = 1;
      }
      return lease;
    };
    let assertionCount = 0;
    scheduler.assertCurrentAsync = async () => {
      assertionCount += 1;
      if (assertionCount === 2) {
        throw Object.assign(new Error('Simulated workflow lease loss after archive commit'), {
          code: 'WORKFLOW_LEASE_NOT_OWNER'
        });
      }
      return true;
    };

    const firstLoop = makeDeleteAgentLoop(memoryTool, operationRepository);
    const firstWorker = new AsyncWorkflowWorker({
      scheduler,
      workerId: 'memory-delete-worker-before-lease-loss',
      tenantId,
      executor: async ({ instance: leasedInstance }) => firstLoop.run({
        plan,
        context: makeContext(leasedInstance, plan, tenantId),
        runtimeContext: { tenantId, memoryScope: 'personal', planRevision: 1 }
      })
    });
    // The worker API returns the current workflow instance even when the lease is lost;
    // the durable operation receipt, not a null return value, is the recovery contract.
    assert.ok(await firstWorker.tick());
    const operationRecord = [...operationRepository.records.values()].find(record => record.tool === 'memory.delete');
    assert.ok(operationRecord);
    assert.equal(operationRecord.status, 'completed');
    const archiveReceipts = initial.auditRepository.findByOperationId(
      operationRecord.operationId, tenantId, 'personal'
    );
    assert.equal(archiveReceipts.length, 1);
    assert.equal(archiveReceipts[0].action, 'memory.archived');

    const recoveredInstance = WorkflowInstance.fromJSON(instance.toJSON());
    recoveredInstance.recoverFromLeaseLoss('WORKFLOW_LEASE_NOT_OWNER');
    await scheduler.enqueueDurable(recoveredInstance);

    const restarted = createMemoryService(root);
    const restartedMemoryTool = createMemoryTools(restarted.service).find(tool => tool.name === 'memory.delete');
    const secondLoop = makeDeleteAgentLoop(restartedMemoryTool, operationRepository);
    const secondWorker = new AsyncWorkflowWorker({
      scheduler,
      workerId: 'memory-delete-worker-after-lease-loss',
      tenantId,
      executor: async ({ instance: leasedInstance }) => secondLoop.run({
        plan,
        context: makeContext(leasedInstance, plan, tenantId),
        runtimeContext: { tenantId, memoryScope: 'personal', planRevision: 1 }
      })
    });

    const recovered = await secondWorker.tick();
    assert.ok(recovered);
    assert.equal(recovered.state, WorkflowInstance.STATES.COMPLETED);
    assert.equal(operationRepository.records.size, 1, 'only the delete is executed through AgentLoop in this test');
    const finalReceipts = restarted.auditRepository.findByOperationId(
      operationRecord.operationId, tenantId, 'personal'
    );
    assert.equal(finalReceipts.length, 1, 'recovery must not append a second archive receipt');
    assert.equal(finalReceipts[0].action, 'memory.archived');
    assert.deepEqual(
      restarted.service.reconcileToolOperation('memory.delete', { id: seeded.id, scope: 'personal' }, {
        tenantId,
        memoryScope: 'personal',
        operationId: operationRecord.operationId
      }),
      { status: 'completed', result: true }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
