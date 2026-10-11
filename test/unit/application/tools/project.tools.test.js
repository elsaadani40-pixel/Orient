'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const createProjectTools = require('../../../../src/application/tools/project.tools');

async function withProject(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-project-tools-'));
  try {
    await fs.writeFile(path.join(root, 'main.js'), 'const marker = "already-present";\n', 'utf8');
    const tools = createProjectTools({
      projectRoot: root,
      policy: { allowRead: true, allowWrite: false, allowCommands: false, allowGit: false }
    });
    await run({ root, execute: tools.find(tool => tool.name === 'project.execute_change') });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('legacy project change reconciliation fails closed when matching contents have no durable receipt', async () => {
  await withProject(async ({ execute }) => {
    const result = await execute.reconcile({
      proposals: [{
        action: 'update',
        path: 'main.js',
        content: 'const marker = "already-present";\n'
      }]
    });

    assert.equal(result.status, 'conflict');
    assert.equal(result.reason, 'operation_receipt_missing');
    assert.deepEqual(result.observations, [{ path: 'main.js', applied: true }]);
  });
});

test('legacy project change reconciliation reports conflicting target state', async () => {
  await withProject(async ({ execute }) => {
    const result = await execute.reconcile({
      proposals: [{
        action: 'update',
        path: 'main.js',
        content: 'const marker = "different";\n'
      }]
    });

    assert.equal(result.status, 'conflict');
    assert.equal(result.reason, 'external_state_does_not_match_expected_post_state');
    assert.deepEqual(result.observations, [{ path: 'main.js', applied: false }]);
  });
});
