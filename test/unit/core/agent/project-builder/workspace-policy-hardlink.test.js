const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WorkspacePolicy = require('../../../../../../src/core/agent/project-builder/workspace/workspace-policy');

test('rejects writes to a hardlinked file that could modify a file outside the workspace', () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-hardlink-'));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside.txt');
  const target = path.join(root, 'target.txt');

  fs.mkdirSync(root);
  fs.writeFileSync(outside, 'protected');
  fs.linkSync(outside, target);

  const policy = new WorkspacePolicy({
    allowedRoot: root,
    allowWrite: true
  });

  assert.throws(
    () => policy.assertWrite('target.txt'),
    /hardlink and is denied/
  );

  assert.equal(fs.readFileSync(outside, 'utf8'), 'protected');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('allows ordinary existing files inside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-hardlink-safe-'));
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(target, 'safe');

  const policy = new WorkspacePolicy({
    allowedRoot: root,
    allowWrite: true
  });

  assert.equal(policy.assertWrite('target.txt'), target);

  fs.rmSync(root, { recursive: true, force: true });
});
