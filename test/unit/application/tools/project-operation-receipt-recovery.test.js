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

test('pending operation intents are tenant-scoped and cannot be rebound to different changes', async () => {
  await withFixture(async ({ store }) => {
    const identity = {
      operationId: 'pending-intent-identity',
      tenantId: 'tenant-a',
      workspaceId: 'a'.repeat(64),
      changeSetHash: 'b'.repeat(64)
    };
    const first = store.beginIntent(identity);
    assert.equal(first.created, true);
    assert.equal(store.readIntent(identity).status, 'pending');

    const duplicate = store.beginIntent(identity);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.intent.changeSetHash, identity.changeSetHash);

    assert.equal(store.readIntent({ ...identity, tenantId: 'tenant-b' }), null);
    assert.throws(
      () => store.beginIntent({ ...identity, changeSetHash: 'c'.repeat(64) }),
      error => error?.code === 'PROJECT_OPERATION_INTENT_IDENTITY_CONFLICT'
    );
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
    assert.equal(store.readIntent(context), null, 'verified receipt is durable before its pending intent is removed');

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
    assert.equal(recovered.reason, 'operation_outcome_unknown');
    assert.ok(recovered.intent, 'pending intent preserves uncertainty after receipt persistence fails');
    await assert.rejects(
      execute.execute(input, context),
      error => error?.code === 'PROJECT_OPERATION_OUTCOME_UNKNOWN'
    );
    assert.equal(
      await fs.readFile(path.join(root, 'src/receipt-write-failure.txt'), 'utf8'),
      'verified but receipt unavailable\n',
      'retry must not replay a mutation whose receipt could not be committed'
    );
  });
});


test('a receipt bound to different proposal content is a conflict, even when workspace files match the new proposal', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const original = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'original verified content\\n' }]
    };
    const context = { operationId: 'operation-proposal-mismatch', tenantId: 'tenant-a' };
    const result = await execute.execute(original, context);
    assert.equal(result.status, 'verified');

    const changed = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'different content\\n' }]
    };
    await fs.writeFile(path.join(root, 'src/generated.txt'), 'different content\\n');
    const recovered = await execute.reconcile(changed, context);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_receipt_identity_conflict');
  });
});

test('a corrupt durable receipt fails closed instead of returning a recovered result', async () => {
  await withFixture(async ({ store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'verified content\\n' }]
    };
    const context = { operationId: 'operation-corrupt-receipt', tenantId: 'tenant-a' };
    const result = await execute.execute(input, context);
    assert.equal(result.status, 'verified');

    await fs.writeFile(store.receiptPath(context.operationId, context.tenantId), '{not valid json', 'utf8');
    const recovered = await execute.reconcile(input, context);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'PROJECT_OPERATION_RECEIPT_CORRUPT');
  });
});

test('a durable pending intent blocks replay when a crash leaves matching workspace bytes without a receipt', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/uncertain-operation.txt', content: 'possibly applied\\n' }]
    };
    const context = { operationId: 'operation-crash-window', tenantId: 'tenant-a' };
    const workspaceId = require('node:crypto').createHash('sha256')
      .update(path.resolve(root), 'utf8').digest('hex');
    const changeSetHash = require('node:crypto').createHash('sha256')
      .update(JSON.stringify(input.proposals.map(({ action, path: proposalPath, content, expectedContentSha256 }) => ({
        action, path: proposalPath, content, ...(expectedContentSha256 ? { expectedContentSha256 } : {})
      }))), 'utf8').digest('hex');

    store.beginIntent({ ...context, workspaceId, changeSetHash });
    await fs.writeFile(path.join(root, 'src/uncertain-operation.txt'), 'possibly applied\\n');

    const recovered = await execute.reconcile(input, context);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_outcome_unknown');

    await assert.rejects(
      execute.execute(input, context),
      error => error?.code === 'PROJECT_OPERATION_OUTCOME_UNKNOWN'
    );
    assert.equal(
      await fs.readFile(path.join(root, 'src/uncertain-operation.txt'), 'utf8'),
      'possibly applied\\n',
      'matching bytes alone must not authorize replay or claim completion'
    );
  });
});

test('a receipted operation ID is not replayed when the workspace has drifted', async () => {
  await withFixture(async ({ root, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/replay-guard.txt', content: 'verified original\\n' }]
    };
    const context = { operationId: 'operation-replay-guard', tenantId: 'tenant-a' };
    const first = await execute.execute(input, context);
    assert.equal(first.status, 'verified');

    // Simulate an intervening change after the original operation completed.
    await fs.writeFile(path.join(root, 'src/replay-guard.txt'), 'external change\\n');

    await assert.rejects(
      execute.execute(input, context),
      error => error?.code === 'PROJECT_OPERATION_REPLAY_CONFLICT'
    );
    assert.equal(
      await fs.readFile(path.join(root, 'src/replay-guard.txt'), 'utf8'),
      'external change\\n',
      'a repeated operation must not overwrite workspace drift'
    );
  });
});
