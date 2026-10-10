'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ProjectBuilderAgent = require('../../../../src/core/agent/project-builder/project-builder-agent');
const createWorkspaceTools = require('../../../../src/application/tools/workspace.tools');

async function withWorkspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-workspace-tools-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'main.js'), "const marker = 'NeedleValue';\nmodule.exports = marker;\n");
    await fs.writeFile(path.join(root, '.env'), 'OWNER_PASSWORD=must-not-be-read\n');
    await fs.mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'fixture', 'hidden.js'), 'NeedleValue\n');
    const projectBuilder = new ProjectBuilderAgent({
      projectRoot: root,
      policy: { allowRead: true, allowWrite: false, allowCommands: false, allowGit: false }
    });
    await run({ root, projectBuilder, tools: createWorkspaceTools(projectBuilder) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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


test('project change reconciliation recognizes an already-applied change without writing again', async () => {
  await withWorkspace(async ({ root, tools }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    const original = await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8');
    const proposed = "const marker = 'recovered';\\nmodule.exports = marker;\\n";
    const expectedContentSha256 = crypto.createHash('sha256').update(original, 'utf8').digest('hex');

    // Model a crash after the filesystem commit but before the idempotency ledger
    // records the operation as completed.
    await fs.writeFile(path.join(root, 'src', 'main.js'), proposed, 'utf8');
    const result = await execute.reconcile({
      changeSet: {
        changes: [{
          action: 'update',
          path: 'src/main.js',
          content: proposed,
          expectedContentSha256
        }]
      }
    }, {});

    assert.equal(result.status, 'completed');
    assert.equal(result.result.verification.reconciled, true);
    assert.equal(result.result.verification.checkedFiles, 1);
    assert.equal(await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'), proposed);
  });
});

test('project change reconciliation fails closed on partial or unproven application', async () => {
  await withWorkspace(async ({ root, tools }) => {
    const execute = tools.find(tool => tool.name === 'project.execute_change');
    const original = await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8');
    const expectedContentSha256 = crypto.createHash('sha256').update(original, 'utf8').digest('hex');
    const proposed = "const marker = 'partially-recovered';\\nmodule.exports = marker;\\n";

    await fs.writeFile(path.join(root, 'src', 'main.js'), proposed, 'utf8');
    const partial = await execute.reconcile({
      changeSet: {
        changes: [
          { action: 'update', path: 'src/main.js', content: proposed, expectedContentSha256 },
          { action: 'create', path: 'src/new.js', content: 'module.exports = true;\\n' }
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
