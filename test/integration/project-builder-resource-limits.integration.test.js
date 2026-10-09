'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const WorkspacePolicy = require('../../src/core/agent/project-builder/workspace/workspace-policy');
const CommandRunner = require('../../src/core/agent/project-builder/workspace/command-runner');

function prerequisitesUnavailable() {
  if (process.platform !== 'linux') return 'Linux is required';
  if (!fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) return 'cgroup v2 is unavailable';
  const controllers = fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8').trim().split(/\s+/);
  if (!['cpu', 'memory', 'pids'].every(controller => controllers.includes(controller))) {
    return 'required cgroup v2 controllers are unavailable';
  }
  const manager = spawnSync('systemctl', ['--user', 'is-active', 'default.target'], {
    encoding: 'utf8',
    timeout: 2000
  });
  if (manager.status !== 0) return 'systemd user manager is unavailable';
  return null;
}

test('Project Builder command runs in a systemd cgroup with configured OS-enforced limits', async t => {
  const unavailable = prerequisitesUnavailable();
  if (unavailable) {
    t.skip(unavailable);
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-resource-limits-'));
  try {
    const policy = new WorkspacePolicy({
      allowedRoot: root,
      allowCommands: true,
      allowedCommands: ['node'],
      timeoutMs: 10000,
      maxOutput: 4096
    });
    const runner = new CommandRunner({ policy });
    const result = await runner.run('node', {
      args: ['-e', 'setTimeout(() => process.stdout.write("resource-limits-ok"), 500)']
    });

    if (result.code !== 0 && /Failed RTM_NEWADDR|Operation not permitted|Creating new namespace failed/.test(result.stderr || '')) {
      t.skip('host kernel disallows the Bubblewrap namespace required by the sandbox');
      return;
    }

    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stdout, 'resource-limits-ok');
    assert.equal(result.resourceLimitMode, 'systemd-user-service-cgroup-v2');
    assert.ok(['success', 'running'].includes(result.resourceLimitStatus?.result), JSON.stringify(result.resourceLimitStatus));
    const properties = result.resourceLimitStatus?.enforcedProperties;
    assert.ok(properties, 'effective systemd resource properties must be observable');
    assert.notEqual(properties.memoryMax, 'unknown');
    assert.notEqual(properties.cpuQuotaPerSecUSec, 'unknown');
    assert.notEqual(properties.tasksMax, 'unknown');
    assert.notEqual(properties.limitNoFile, 'unknown');
    assert.notEqual(properties.limitFSize, 'unknown');
    assert.notEqual(properties.runtimeMaxUSec, 'unknown');
    assert.notEqual(properties.limitCPU, 'unknown');
    assert.equal(properties.memorySwapMax, '0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
