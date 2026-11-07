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
    const isolator = new BubblewrapIsolator({ platform, env: {} });
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
      env: {},
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

test('explicit non-Linux opt-in starts only the allowlisted executable without a shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-unsandboxed-opt-in-'));
  const calls = [];
  const child = { pid: 1234, kill() { return true; } };
  const isolator = new BubblewrapIsolator({
    platform: 'darwin',
    env: { PATH: '/trusted/bin', ORIENT_ALLOW_UNSANDBOXED: '1', PRIVATE_TOKEN: 'must-not-leak' },
    spawnProcess(...args) { calls.push(args); return child; }
  });

  try {
    const result = isolator.spawn({
      executable: '/trusted/bin/node',
      args: ['-e', 'process.exit(0)'],
      workspaceRoot: root,
      cwd: root,
      environment: { ORIENT_TEST: '1' },
      timeoutMs: 1000,
      resourceLimits: { maxProcesses: 2 }
    });

    assert.equal(result, child);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/trusted/bin/node');
    assert.deepEqual(calls[0][1], ['-e', 'process.exit(0)']);
    assert.equal(calls[0][2].shell, false);
    assert.equal(calls[0][2].cwd, root);
    assert.deepEqual(calls[0][2].env, { PATH: '/trusted/bin', ORIENT_TEST: '1' });
    assert.equal(child.orientUnsandboxed, true);
    assert.equal(child.orientResourceLimitsVerified, false);
    assert.equal(child.orientResourceLimitMode, 'unsandboxed-opt-in');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-Linux opt-in still rejects a working directory outside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-unsandboxed-root-'));
  let spawnCalls = 0;
  const isolator = new BubblewrapIsolator({
    platform: 'win32',
    env: { PATH: 'C:\\trusted\\bin', ORIENT_ALLOW_UNSANDBOXED: '1' },
    spawnProcess() { spawnCalls += 1; return {}; }
  });

  try {
    assert.throws(
      () => isolator.spawn({
        executable: 'node',
        workspaceRoot: root,
        cwd: process.cwd()
      }),
      /working directory escapes isolated workspace/
    );
    assert.equal(spawnCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux ignores the non-Linux unsandboxed opt-in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-linux-opt-in-'));
  const isolator = new BubblewrapIsolator({
    platform: 'linux',
    env: { ORIENT_ALLOW_UNSANDBOXED: '1' }
  });

  try {
    assert.ok(isolator.buildArgs({
      executable: '/usr/bin/node',
      workspaceRoot: root,
      cwd: root
    }).includes('--unshare-all'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CommandRunner preserves the stable no-sandbox error from its isolator', async () => {
  const isolator = new BubblewrapIsolator({ platform: 'win32', env: {} });
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
