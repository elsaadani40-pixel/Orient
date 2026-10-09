'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SYSTEM_MOUNTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/opt',
  '/etc'
];

/**
 * Linux-only OS isolation for untrusted project-builder commands.
 * There is deliberately no direct-execution fallback: missing bubblewrap or
 * unavailable namespaces means execution is denied.
 */
class BubblewrapIsolator {
  constructor({ spawnProcess = spawn, platform = process.platform } = {}) {
    this.spawnProcess = spawnProcess;
    this.platform = platform;
  }

  buildArgs({ executable, args = [], workspaceRoot, cwd, environment = {} }) {
    if (this.platform !== 'linux') {
      throw new Error('OS-isolated command execution is supported only on Linux; refusing unsafe fallback');
    }

    const root = fs.realpathSync.native(workspaceRoot);
    const workingDirectory = fs.realpathSync.native(cwd);
    const relativeCwd = path.relative(root, workingDirectory);
    if (
      relativeCwd === '..' ||
      relativeCwd.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeCwd)
    ) {
      throw new Error('Command working directory escapes isolated workspace');
    }

    const argsForSandbox = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all'
    ];

    for (const mount of SYSTEM_MOUNTS) {
      if (fs.existsSync(mount)) argsForSandbox.push('--ro-bind', mount, mount);
    }

    argsForSandbox.push(
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--bind', root, '/workspace',
      '--chdir', relativeCwd ? path.posix.join('/workspace', relativeCwd.split(path.sep).join('/')) : '/workspace',
      '--clearenv',
      '--setenv', 'PATH', `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`
    );

    for (const [key, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid sandbox environment variable name: ${key}`);
      }
      argsForSandbox.push('--setenv', key, String(value));
    }

    argsForSandbox.push('--', executable, ...args.map(String));
    return argsForSandbox;
  }

  spawn({ executable, args = [], workspaceRoot, cwd, environment = {}, timeoutMs }) {
    const bwrap = process.env.ORIENT_BWRAP_PATH || 'bwrap';
    const sandboxArgs = this.buildArgs({
      executable,
      args,
      workspaceRoot,
      cwd,
      environment
    });

    return this.spawnProcess(bwrap, sandboxArgs, {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      detached: true,
      env: { PATH: process.env.PATH || '' },
      timeoutMs
    });
  }
}

module.exports = BubblewrapIsolator;
