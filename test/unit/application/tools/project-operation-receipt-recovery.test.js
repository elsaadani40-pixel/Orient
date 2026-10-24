'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const createProjectTools = require('../../../../src/application/tools/project.tools');
const ProjectOperationReceiptStore = require('../../../../src/infrastructure/execution/project-operation-receipt-store');

async function withFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-project-receipt-workspace-'));
  const receiptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-project-receipts-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const store = new ProjectOperationReceiptStore({ directory: receiptDirectory });
    const tools = createProjectTools({
      projectRoot: root,
      policy: { allowRead: true, allowWrite: true, allowCommands: false, allowGit: false },
      operationReceiptStore: store
    });
    await run({ root, store, execute: tools.find(tool => tool.name === 'project.execute_change') });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(receiptDirectory, { recursive: true, force: true });
  }
}

test('project mutation declares receipt-backed reconciliation in tool metadata', async () => {
  await withFixture(async ({ execute }) => {
    assert.equal(execute.effects, 'local_mutation');
    assert.equal(execute.idempotency, 'reconcilable');
    assert.equal(typeof execute.reconcile, 'function');
  });
});

test('verified project mutation writes a tenant-scoped receipt and reconciles only from that receipt', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'approved content\n' }]
    };
    const context = { operationId: 'operation-project-001', tenantId: 'tenant-a' };
    const result = await execute.execute(input, context);
    assert.equal(result.status, 'verified');
    assert.equal((await fs.readFile(path.join(root, 'src/generated.txt'), 'utf8')), 'approved content\n');

    const receipt = store.read(context);
    assert.equal(receipt.operationId, context.operationId);
    assert.equal(receipt.tenantId, context.tenantId);
    assert.equal(receipt.result.status, 'verified');

    const recovered = await execute.reconcile(input, context);
    assert.equal(recovered.status, 'completed');
    assert.deepEqual(recovered.result, receipt.result);
  });
});

test('matching workspace bytes without a receipt remain a fail-closed conflict', async () => {
  await withFixture(async ({ root, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'possibly external\n' }]
    };
    await fs.writeFile(path.join(root, 'src/generated.txt'), 'possibly external\n');
    const recovered = await execute.reconcile(input, {
      operationId: 'operation-without-receipt',
      tenantId: 'tenant-a'
    });
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_receipt_missing');
  });
});

test('receipt from another tenant cannot reconcile the same operation ID', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'approved content\n' }]
    };
    await fs.writeFile(path.join(root, 'src/generated.txt'), 'approved content\n');
    const context = { operationId: 'shared-operation', tenantId: 'tenant-a' };
    store.write({
      ...context,
      workspaceId: require('node:crypto').createHash('sha256').update(path.resolve(root), 'utf8').digest('hex'),
      changeSetHash: require('node:crypto').createHash('sha256').update(JSON.stringify(input.proposals.map(({ action, path: proposalPath, content, expectedContentSha256 }) => ({
        action, path: proposalPath, content, ...(expectedContentSha256 ? { expectedContentSha256 } : {})
      }))), 'utf8').digest('hex'),
      result: {
        status: 'verified',
        verification: { status: 'passed', failed: 0 },
        modification: { applied: true }
      }
    });
    const recovered = await execute.reconcile(input, {
      operationId: context.operationId,
      tenantId: 'tenant-b'
    });
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_receipt_missing');
  });
});


test('receipt persistence failure after a verified mutation remains unreconciled and cannot be mistaken for success', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/receipt-write-failure.txt', content: 'verified but receipt unavailable\n' }]
    };
    const context = { operationId: 'operation-receipt-write-failure', tenantId: 'tenant-a' };
    store.write = () => {
      const error = new Error('simulated durable receipt storage failure');
      error.code = 'RECEIPT_STORAGE_UNAVAILABLE';
      throw error;
    };

    await assert.rejects(execute.execute(input, context), /simulated durable receipt storage failure/);
    assert.equal(
      await fs.readFile(path.join(root, 'src/receipt-write-failure.txt'), 'utf8'),
      'verified but receipt unavailable\n'
    );

    const recovered = await execute.reconcile(input, context);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_receipt_missing');
  });
});
