'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BubblewrapIsolator = require('../../../../../src/core/agent/project-builder/workspace/bubblewrap-isolator');
const CommandRunner = require('../../../../../src/core/agent/project-builder/workspace/command-runner');

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

for (const platform of ['darwin', 'win32']) {
  test(`unsupported platform ${platform} returns the stable no-sandbox error`, () => {
    const isolator = new BubblewrapIsolator({ platform });
    assert.throws(
      () => isolator.buildArgs({
        executable: 'node',
        workspaceRoot: process.cwd(),
        cwd: process.cwd()
      }),
      error => {
        assert.equal(error.code, 'ORIENT_E_NO_SANDBOX');
        assert.match(error.message, /supported only on Linux; refusing unsafe fallback/);
        return true;
      }
    );
  });

  test(`unsupported platform ${platform} never starts a process`, () => {
    let spawnCalls = 0;
    const isolator = new BubblewrapIsolator({
      platform,
      spawnProcess() {
        spawnCalls += 1;
        throw new Error('spawn must not be called');
      }
    });

    assert.throws(
      () => isolator.spawn({
        executable: 'node',
        workspaceRoot: process.cwd(),
        cwd: process.cwd()
      }),
      error => error.code === 'ORIENT_E_NO_SANDBOX'
    );
    assert.equal(spawnCalls, 0);
  });
}

test('CommandRunner preserves the stable no-sandbox error from its isolator', async () => {
  const isolator = new BubblewrapIsolator({ platform: 'win32' });
  const runner = new CommandRunner({
    policy: {
      allowedRoot: process.cwd(),
      environment: {},
      timeoutMs: 1000,
      resourceLimits: {},
      assertCommand: command => command,
      resolve: () => process.cwd()
    },
    isolator
  });

  await assert.rejects(
    runner.run('node'),
    error => error.code === 'ORIENT_E_NO_SANDBOX'
  );
});
