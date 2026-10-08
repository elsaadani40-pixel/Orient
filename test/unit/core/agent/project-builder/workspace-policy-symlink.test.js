const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WorkspacePolicy = require('../../../../../src/core/agent/project-builder/workspace/workspace-policy');

test('rejects symlink paths that resolve outside the workspace root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workspace-'));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');

  const policy = new WorkspacePolicy({ allowedRoot: root, allowRead: true, allowWrite: true });

  assert.throws(
    () => policy.resolve('escape/secret.txt'),
    /escapes allowed root/
  );
});

test('allows normal paths and new files inside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workspace-safe-'));
  const policy = new WorkspacePolicy({ allowedRoot: root, allowRead: true, allowWrite: true });

  assert.equal(policy.resolve('src/new-file.js'), path.join(root, 'src/new-file.js'));
});
