const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WorkspacePolicy = require('../../../../../src/core/agent/project-builder/workspace/workspace-policy');

test('rejects writes to a hardlinked file that could modify a file outside the workspace', t => {
  if (process.platform === 'win32') {
    t.skip('hardlink protection fixture requires POSIX hardlink semantics');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-hardlink-'));
  try {
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside.txt');
    const target = path.join(root, 'target.txt');

    fs.mkdirSync(root);
    fs.writeFileSync(outside, 'protected');

    try {
      fs.linkSync(outside, target);
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        t.skip(`host does not permit hardlink creation (${error.code}); hardlink policy assertion was not exercised`);
        return;
      }
      throw error;
    }

    const policy = new WorkspacePolicy({
      allowedRoot: root,
      allowWrite: true
    });

    assert.throws(
      () => policy.assertWrite('target.txt'),
      /hardlink and is denied/
    );

    assert.equal(fs.readFileSync(outside, 'utf8'), 'protected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('allows ordinary existing files inside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-hardlink-safe-'));
  try {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'safe');

    const policy = new WorkspacePolicy({
      allowedRoot: root,
      allowWrite: true
    });

    assert.equal(policy.assertWrite('target.txt'), target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
