'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
