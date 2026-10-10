'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ProjectBuilderAgent = require('../../../../src/core/agent/project-builder/project-builder-agent');
const createWorkspaceTools = require('../../../../src/application/tools/workspace.tools');
const ProjectOperationReceiptStore = require('../../../../src/infrastructure/execution/project-operation-receipt-store');

async function withWorkspace(run, { allowWrite = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-workspace-tools-'));
  const receiptDirectory = path.join(os.tmpdir(), 'orient-operation-receipts-' + crypto.randomUUID());
  const operationReceiptStore = new ProjectOperationReceiptStore({ directory: receiptDirectory });
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'main.js'), "const marker = 'NeedleValue';\nmodule.exports = marker;\n");
    await fs.writeFile(path.join(root, '.env'), 'OWNER_PASSWORD=must-not-be-read\n');
    await fs.mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'fixture', 'hidden.js'), 'NeedleValue\n');
    const projectBuilder = new ProjectBuilderAgent({
      projectRoot: root,
      policy: { allowRead: true, allowWrite, allowCommands: false, allowGit: false }
    });
    await run({
      root,
      projectBuilder,
      operationReceiptStore,
      tools: createWorkspaceTools(projectBuilder, { operationReceiptStore })
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(receiptDirectory, { recursive: true, force: true });
  }
}

test('workspace read returns bounded text and a content hash', async () => {
  await withWorkspace(async ({ tools }) => {
    const read = tools.find(tool => tool.name === 'workspace.read');
    const result = await read.execute({ path: 'src/main.js' }, {});
    assert.equal(result.path, 'src/main.js');
    assert.match(result.content, /NeedleValue/);
    assert.equal(result.truncated, false);
    assert.match(result.contentSha256, /^[a-f0-9]{64}$/);
  });
});

test('workspace tools deny traversal and sensitive paths by default', async () => {
  await withWorkspace(async ({ tools }) => {
    const read = tools.find(tool => tool.name === 'workspace.read');
    await assert.rejects(
      () => read.execute({ path: '../outside.txt' }, {}),
      error => error.code === 'WORKSPACE_PATH_FORBIDDEN'
    );
    await assert.rejects(
      () => read.execute({ path: '.env' }, {}),
      error => error.code === 'WORKSPACE_SENSITIVE_PATH_DENIED'
    );
  });
});

test('workspace search is literal, bounded, and skips credentials and dependency folders', async () => {
  await withWorkspace(async ({ tools }) => {
    const search = tools.find(tool => tool.name === 'workspace.search');
    const result = await search.execute({ query: 'NeedleValue' }, {});
    assert.equal(result.query, 'NeedleValue');
    assert.ok(result.results.some(match => match.path === 'src/main.js'));
    assert.equal(result.results.some(match => match.path.includes('node_modules')), false);
    assert.ok(result.filesScanned < 10);
  });
});

test('workspace listing hides sensitive paths and exposes project audit as read-only', async () => {
  await withWorkspace(async ({ tools }) => {
    const list = tools.find(tool => tool.name === 'workspace.list');
    const result = await list.execute({ path: '.' }, {});
    assert.equal(result.entries.some(entry => entry.name === '.env'), false);
    assert.equal(result.entries.some(entry => entry.name === 'node_modules'), false);

    const audit = tools.find(tool => tool.name === 'project.audit');
    const auditResult = await audit.execute(null, {});
    assert.ok(['healthy', 'needs-work', 'blocked'].includes(auditResult.status));
    assert.ok(Array.isArray(auditResult.findings));
  });
});

test('change execution is explicitly high-risk and refuses empty or unbound change sets', async () => {
  await withWorkspace(async ({ tools }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    assert.equal(execute.risk, 'high');
    assert.ok(execute.capabilities.includes('workspace.write'));
    await assert.rejects(
      () => execute.execute({ proposals: [] }, {}),
      error => error.code === 'CHANGE_SET_EMPTY'
    );
    await assert.rejects(
      () => execute.execute({
        proposals: [{ action: 'update', path: 'src/main.js', content: 'changed' }]
      }, {}),
      error => error.code === 'CHANGE_PRECONDITION_REQUIRED'
    );
  });
});

test('workspace read rejects symlinks even when their target is inside the root', async () => {
  await withWorkspace(async ({ root, tools }) => {
    await fs.symlink(path.join(root, '.env'), path.join(root, 'src', 'env-alias.js'));
    const read = tools.find(tool => tool.name === 'workspace.read');
    await assert.rejects(
      () => read.execute({ path: 'src/env-alias.js' }, {}),
      error => error.code === 'WORKSPACE_PATH_FORBIDDEN'
    );
  });
});


test('project change reconciliation does not infer operation completion from matching file contents alone', async () => {
  await withWorkspace(async ({ root, tools }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    const original = await fs.readFile(path.join(root, 'src/main.js'), 'utf8');
    const proposed = "const marker = 'recovered';\\nmodule.exports = marker;\\n";
    const expectedContentSha256 = crypto.createHash('sha256').update(original, 'utf8').digest('hex');

    // Model a crash after the filesystem commit but before local idempotency
    // completion. Identical bytes are not an authoritative operation receipt:
    // another writer could have independently produced the same content.
    await fs.writeFile(path.join(root, 'src/main.js'), proposed, 'utf8');
    const result = await execute.reconcile({
      changeSet: {
        changes: [{
          action: 'update',
          path: 'src/main.js',
          content: proposed,
          expectedContentSha256
        }]
      }
    }, { operationId: 'operation-after-crash', tenantId: 'tenant-a' });

    assert.equal(result.status, 'conflict');
    assert.equal(result.reason, 'operation_receipt_missing');
    assert.equal(result.observations[0].postStateMatches, true);
    assert.equal(await fs.readFile(path.join(root, 'src/main.js'), 'utf8'), proposed);
  });
});

test('project change reconciliation fails closed on partial or unproven application', async () => {
  await withWorkspace(async ({ root, tools }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    const original = await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8');
    const expectedContentSha256 = crypto.createHash('sha256').update(original, 'utf8').digest('hex');
    const proposed = "const marker = 'partially-recovered';\nmodule.exports = marker;\n";

    await fs.writeFile(path.join(root, 'src', 'main.js'), proposed, 'utf8');
    const partial = await execute.reconcile({
      changeSet: {
        changes: [
          { action: 'update', path: 'src/main.js', content: proposed, expectedContentSha256 },
          { action: 'create', path: 'src/new.js', content: 'module.exports = true;\n' }
        ]
      }
    }, {});
    assert.equal(partial.status, 'conflict');
    assert.equal(partial.reason, 'partially_applied_change_set');

    const untouched = await execute.reconcile({
      changeSet: {
        changes: [{
          action: 'update',
          path: 'src/main.js',
          content: 'another proposal',
          expectedContentSha256: crypto.createHash('sha256').update(proposed, 'utf8').digest('hex')
        }]
      }
    }, {});
    assert.equal(untouched.status, 'conflict');
    assert.equal(untouched.reason, 'no_changes_proven_applied');
  });
});

test('project change reconciliation completes only with a matching durable receipt', async () => {
  await withWorkspace(async ({ root, tools, operationReceiptStore, projectBuilder }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    const original = await fs.readFile(path.join(root, 'src/main.js'), 'utf8');
    const proposed = "const marker = 'receipted';\\nmodule.exports = marker;\\n";
    const change = {
      action: 'update',
      path: 'src/main.js',
      content: proposed,
      expectedContentSha256: crypto.createHash('sha256').update(original, 'utf8').digest('hex')
    };
    const changes = [change];
    const toolResult = {
      status: 'verified',
      changes: [{ action: 'update', path: 'src/main.js' }],
      verification: { status: 'passed', failed: 0, passed: 1 },
      policy: { allowed: true },
      rollback: null,
      error: null
    };
    await fs.writeFile(path.join(root, 'src/main.js'), proposed, 'utf8');
    const workspaceId = crypto.createHash('sha256').update(path.resolve(projectBuilder.policy.realAllowedRoot), 'utf8').digest('hex');
    const changeSetHash = crypto.createHash('sha256').update(JSON.stringify(changes), 'utf8').digest('hex');
    operationReceiptStore.write({
      operationId: 'receipt-operation',
      tenantId: 'tenant-a',
      workspaceId,
      changeSetHash,
      result: toolResult
    });

    const reconciled = await execute.reconcile({ changeSet: { changes } }, {
      operationId: 'receipt-operation',
      tenantId: 'tenant-a'
    });
    assert.equal(reconciled.status, 'completed');
    assert.deepEqual(reconciled.result, toolResult);
  });
});

test('project change reconciliation rejects a receipt bound to a different changeset', async () => {
  await withWorkspace(async ({ root, tools, operationReceiptStore, projectBuilder }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    const original = await fs.readFile(path.join(root, 'src/main.js'), 'utf8');
    const proposed = "const marker = 'receipt-mismatch';\\nmodule.exports = marker;\\n";
    const changes = [{
      action: 'update',
      path: 'src/main.js',
      content: proposed,
      expectedContentSha256: crypto.createHash('sha256').update(original, 'utf8').digest('hex')
    }];
    await fs.writeFile(path.join(root, 'src/main.js'), proposed, 'utf8');
    operationReceiptStore.write({
      operationId: 'receipt-mismatch-operation',
      tenantId: 'tenant-a',
      workspaceId: crypto.createHash('sha256').update(path.resolve(projectBuilder.policy.realAllowedRoot), 'utf8').digest('hex'),
      changeSetHash: 'a'.repeat(64),
      result: {
        status: 'verified',
        changes: [{ action: 'update', path: 'src/main.js' }],
        verification: { status: 'passed', failed: 0, passed: 1 },
        policy: { allowed: true },
        rollback: null,
        error: null
      }
    });

    const reconciled = await execute.reconcile({ changeSet: { changes } }, {
      operationId: 'receipt-mismatch-operation',
      tenantId: 'tenant-a'
    });
    assert.equal(reconciled.status, 'conflict');
    assert.equal(reconciled.reason, 'operation_receipt_identity_mismatch');
  });
});

test('project operation receipt store fails closed on corrupt receipt data', async () => {
  await withWorkspace(async ({ operationReceiptStore }) => {
    const receiptPath = operationReceiptStore.receiptPath('corrupt-operation', 'tenant-a');
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, '{not-json', 'utf8');
    assert.throws(
      () => operationReceiptStore.read({ operationId: 'corrupt-operation', tenantId: 'tenant-a' }),
      error => error.code === 'PROJECT_OPERATION_RECEIPT_CORRUPT'
    );
  });
});

test('verified project execution persists a receipt and same-operation retry reuses it', async () => {
  await withWorkspace(async ({ root, tools, operationReceiptStore }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    const original = await fs.readFile(path.join(root, 'src/main.js'), 'utf8');
    const proposed = "const marker = 'persisted-receipt';\\nmodule.exports = marker;\\n";
    const input = {
      changeSet: {
        changes: [{
          action: 'update',
          path: 'src/main.js',
          content: proposed,
          expectedContentSha256: crypto.createHash('sha256').update(original, 'utf8').digest('hex')
        }]
      }
    };
    const context = { operationId: 'verified-operation', tenantId: 'tenant-a' };

    const first = await execute.execute(input, context);
    assert.equal(first.status, 'verified');
    assert.equal(first.verification.status, 'passed');
    const receipt = operationReceiptStore.read(context);
    assert.equal(receipt.result.status, 'verified');

    // The original precondition no longer matches after the first write. A retry
    // must therefore be satisfied by the receipt, not by executing the change again.
    const second = await execute.execute(input, context);
    assert.deepEqual(second, first);

    await assert.rejects(
      () => execute.execute({
        changeSet: {
          changes: [{
            action: 'update',
            path: 'src/main.js',
            content: 'different change',
            expectedContentSha256: crypto.createHash('sha256').update(proposed, 'utf8').digest('hex')
          }]
        }
      }, context),
      error => error.code === 'PROJECT_OPERATION_RECEIPT_IDENTITY_CONFLICT'
    );

    await fs.writeFile(path.join(root, 'src/main.js'), 'changed by another writer', 'utf8');
    await assert.rejects(
      () => execute.execute(input, context),
      error => error.code === 'PROJECT_OPERATION_RECEIPT_POST_STATE_CONFLICT'
    );
  }, { allowWrite: true });
});

test('project execution requires runtime operation identity before mutating the workspace', async () => {
  await withWorkspace(async ({ root, tools }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    const original = await fs.readFile(path.join(root, 'src/main.js'), 'utf8');
    const input = {
      changeSet: {
        changes: [{
          action: 'update',
          path: 'src/main.js',
          content: 'must not be written',
          expectedContentSha256: crypto.createHash('sha256').update(original, 'utf8').digest('hex')
        }]
      }
    };
    await assert.rejects(
      () => execute.execute(input, {}),
      error => error.code === 'PROJECT_OPERATION_RECEIPT_IDENTITY_REQUIRED'
    );
    assert.equal(await fs.readFile(path.join(root, 'src/main.js'), 'utf8'), original);
  }, { allowWrite: true });
});
