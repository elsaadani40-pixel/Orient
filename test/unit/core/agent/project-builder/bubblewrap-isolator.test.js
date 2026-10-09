const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BubblewrapIsolator = require('../../../../../src/core/agent/project-builder/workspace/bubblewrap-isolator');

test('Linux isolator creates a private network and exposes workspace as the only writable project mount', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-bwrap-policy-'));
  const isolator = new BubblewrapIsolator({ platform: 'linux' });

  try {
    const args = isolator.buildArgs({
      executable: '/usr/bin/node',
      args: ['-e', 'process.exit(0)'],
      workspaceRoot: root,
      cwd: root,
      environment: { ORIENT_TEST: '1' }
    });

    assert.ok(args.includes('--unshare-all'), 'network and other namespaces must be isolated');
    assert.ok(args.includes('--clearenv'), 'child environment must start empty');
    assert.ok(args.includes('--bind') && args.includes(root), 'workspace must be explicitly bound');
    assert.ok(args.includes('--tmpfs') && args.includes('/tmp'), 'temporary files must be sandbox-local');
    assert.ok(args.includes('--setenv') && args.includes('ORIENT_TEST'), 'only explicit environment variables are forwarded');
    assert.ok(args.includes('--ro-bind'), 'system runtime mounts must be read-only');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-Linux platforms fail closed instead of running commands directly', () => {
  const isolator = new BubblewrapIsolator({ platform: 'win32' });
  assert.throws(
    () => isolator.buildArgs({
      executable: 'node',
      workspaceRoot: process.cwd(),
      cwd: process.cwd()
    }),
    /supported only on Linux; refusing unsafe fallback/
  );
});
