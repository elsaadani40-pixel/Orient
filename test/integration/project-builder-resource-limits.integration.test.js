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


async function runLimitedCommand(t, { resourceLimits, timeoutMs = 5000, script }) {
  const unavailable = prerequisitesUnavailable();
  if (unavailable) {
    t.skip(unavailable);
    return null;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-enforcement-proof-'));
  try {
    const policy = new WorkspacePolicy({
      allowedRoot: root,
      allowCommands: true,
      allowedCommands: ['node'],
      timeoutMs,
      maxOutput: 4096,
      resourceLimits
    });
    const result = await new CommandRunner({ policy }).run('node', {
      args: ['-e', script]
    });

    if (result.code !== 0 && /Failed RTM_NEWADDR|Operation not permitted|Creating new namespace failed/.test(result.stderr || '')) {
      t.skip('host kernel disallows the Bubblewrap namespace required by the sandbox');
      return null;
    }
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('kernel CPU-time limit terminates a CPU-bound command before wall-clock timeout', async t => {
  const result = await runLimitedCommand(t, {
    timeoutMs: 5000,
    resourceLimits: { maxCpuTimeSeconds: 1 },
    script: 'let value = 0; while (true) value = (value + 1) | 0;'
  });
  if (!result) return;
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.failureCode, 'CPU_LIMIT_EXCEEDED', JSON.stringify(result));
});

test('cgroup memory ceiling kills a command that exceeds its memory budget', async t => {
  const result = await runLimitedCommand(t, {
    timeoutMs: 10000,
    resourceLimits: { memoryMaxBytes: 128 * 1024 * 1024 },
    script: 'const memory = Buffer.alloc(512 * 1024 * 1024, 0x5a); process.stdout.write(String(memory.length));'
  });
  if (!result) return;
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.failureCode, 'MEMORY_LIMIT_EXCEEDED', JSON.stringify(result));
});

test('cgroup task ceiling blocks process-fork exhaustion', async t => {
  const result = await runLimitedCommand(t, {
    timeoutMs: 5000,
    resourceLimits: { maxProcesses: 16 },
    script: 'const { spawn } = require("node:child_process");\nconst children = [];\nlet hit = false;\nfor (let i = 0; i < 80; i += 1) {\n  const child = spawn("/bin/sleep", ["5"]);\n  children.push(child);\n  child.on("error", error => {\n    if (error.code === "EAGAIN" && !hit) {\n      hit = true;\n      console.error("PROCESS_LIMIT_EAGAIN");\n      for (const running of children) { try { running.kill("SIGKILL"); } catch {} }\n      setTimeout(() => process.exit(77), 50);\n    }\n  });\n}\nsetTimeout(() => {\n  for (const running of children) { try { running.kill("SIGKILL"); } catch {} }\n  if (!hit) process.exit(0);\n}, 1000);'
  });
  if (!result) return;
  assert.equal(result.failureCode, 'PROCESS_LIMIT_EXCEEDED', JSON.stringify(result));
});

test('per-process file descriptor limit blocks descriptor exhaustion', async t => {
  const result = await runLimitedCommand(t, {
    timeoutMs: 5000,
    resourceLimits: { maxOpenFiles: 32 },
    script: 'const fs = require("node:fs");\nconst descriptors = [];\nlet failure = null;\ntry {\n  for (let i = 0; i < 200; i += 1) descriptors.push(fs.openSync("/dev/null", "r"));\n} catch (error) {\n  failure = error;\n  console.error(error.code);\n} finally {\n  for (const descriptor of descriptors) { try { fs.closeSync(descriptor); } catch {} }\n}\nprocess.exitCode = failure && failure.code === "EMFILE" ? 77 : 0;'
  });
  if (!result) return;
  assert.equal(result.failureCode, 'OPEN_FILE_LIMIT_EXCEEDED', JSON.stringify(result));
});

test('per-process file-size limit blocks oversized regular-file writes', async t => {
  const result = await runLimitedCommand(t, {
    timeoutMs: 5000,
    resourceLimits: { maxFileSizeBytes: 1024 * 1024 },
    script: 'const fs = require("node:fs");\nconst descriptor = fs.openSync("oversized.bin", "w");\nconst chunk = Buffer.alloc(65536, 0x41);\ntry {\n  while (true) fs.writeSync(descriptor, chunk);\n} catch (error) {\n  console.error(error.code);\n  process.exitCode = error.code === "EFBIG" ? 77 : 78;\n} finally {\n  try { fs.closeSync(descriptor); } catch {}\n}'
  });
  if (!result) return;
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.failureCode, 'FILE_SIZE_LIMIT_EXCEEDED', JSON.stringify(result));
});
