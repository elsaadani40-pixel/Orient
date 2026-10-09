'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  normalizeResourceLimits,
  buildSystemdRunArgs
} = require('./resource-limit-policy');

const SYSTEM_MOUNTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/etc'
];

const SYSTEMD_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'SYSTEMD_BUS_ADDRESS'
];

/**
 * Linux-only isolation for untrusted Project Builder commands.
 *
 * Bubblewrap remains the mandatory filesystem/network boundary. A transient
 * systemd user service places bwrap and all descendants into a cgroup before
 * the untrusted executable starts. There is deliberately no direct-spawn,
 * non-cgroup, or unsandboxed fallback.
 */
class BubblewrapIsolator {
  constructor({
    spawnProcess = spawn,
    platform = process.platform,
    systemdRunPath = process.env.ORIENT_SYSTEMD_RUN_PATH || 'systemd-run',
    systemctlPath = process.env.ORIENT_SYSTEMCTL_PATH || 'systemctl'
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.systemdRunPath = systemdRunPath;
    this.systemctlPath = systemctlPath;
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

    const runtimeDirectory = path.dirname(fs.realpathSync.native(process.execPath));
    if (!runtimeDirectory.startsWith('/usr/') &&
        !runtimeDirectory.startsWith('/bin/') &&
        !runtimeDirectory.startsWith('/sbin/') &&
        !runtimeDirectory.startsWith('/lib/')) {
      const components = runtimeDirectory.split('/').filter(Boolean);
      let current = '';
      for (const component of components.slice(0, -1)) {
        current += `/${component}`;
        argsForSandbox.push('--dir', current);
      }
      argsForSandbox.push('--dir', runtimeDirectory);
      argsForSandbox.push('--ro-bind', runtimeDirectory, runtimeDirectory);
    }

    argsForSandbox.push(
      '--dir', '/workspace',
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

  _assertCgroupV2() {
    let cgroupMembership;
    let controllers;

    try {
      cgroupMembership = fs.readFileSync('/proc/self/cgroup', 'utf8');
      controllers = fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8')
        .trim()
        .split(/\\s+/)
        .filter(Boolean);
    } catch (error) {
      const failure = new Error('Required cgroup v2 resource enforcement is unavailable; refusing command execution');
      failure.code = 'RESOURCE_LIMITS_UNAVAILABLE';
      failure.cause = error;
      throw failure;
    }

    if (!/^0::/m.test(cgroupMembership)) {
      const failure = new Error('Unified cgroup v2 is required for Project Builder resource limits');
      failure.code = 'RESOURCE_LIMITS_UNAVAILABLE';
      throw failure;
    }

    for (const controller of ['cpu', 'memory', 'pids']) {
      if (!controllers.includes(controller)) {
        const failure = new Error(`Required cgroup v2 controller "${controller}" is unavailable`);
        failure.code = 'RESOURCE_LIMITS_UNAVAILABLE';
        throw failure;
      }
    }
  }

  _systemdClientEnvironment() {
    const environment = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
    };

    for (const key of SYSTEMD_ENV_KEYS) {
      if (typeof process.env[key] === 'string' && process.env[key].length > 0) {
        environment[key] = process.env[key];
      }
    }

    return environment;
  }

  spawn({
    executable,
    args = [],
    workspaceRoot,
    cwd,
    environment = {},
    timeoutMs,
    resourceLimits = {}
  }) {
    if (this.platform !== 'linux') {
      throw new Error('OS-isolated command execution is supported only on Linux; refusing unsafe fallback');
    }

    const bwrap = process.env.ORIENT_BWRAP_PATH || 'bwrap';
    const sandboxArgs = this.buildArgs({
      executable,
      args,
      workspaceRoot,
      cwd,
      environment
    });
    const limits = normalizeResourceLimits(resourceLimits);
    const unitName = `orient-pb-${crypto.randomUUID()}.service`;
    const supervisorArgs = buildSystemdRunArgs({
      unitName,
      timeoutMs,
      limits,
      executable: bwrap,
      args: sandboxArgs
    });

    const child = this.spawnProcess(this.systemdRunPath, supervisorArgs, {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      detached: true,
      env: this._systemdClientEnvironment()
    });

    // These fields are private coordination metadata consumed by terminate()
    // and inspect(); they are never derived from command/user input.
    child.orientResourceUnitName = unitName;
    child.orientResourceLimits = limits;
    child.orientSystemdEnvironment = this._systemdClientEnvironment();
    return child;
  }

  terminate(child) {
    if (!child || !child.orientResourceUnitName) {
      return Promise.resolve(false);
    }

    const unitName = child.orientResourceUnitName;
    const environment = child.orientSystemdEnvironment || this._systemdClientEnvironment();

    return new Promise(resolve => {
      let completed = 0;
      const finish = () => {
        completed += 1;
        if (completed >= 2) resolve(true);
      };

      for (const args of [
        ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unitName],
        ['--user', 'stop', unitName]
      ]) {
        let cleanup;
        try {
          cleanup = this.spawnProcess(this.systemctlPath, args, {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
            env: environment
          });
        } catch {
          finish();
          continue;
        }
        cleanup.once('error', finish);
        cleanup.once('close', finish);
      }

      try {
        child.kill('SIGTERM');
      } catch {
        // The unit stop is the authoritative process-tree cleanup mechanism.
      }
    });
  }

  inspect(child) {
    if (!child || !child.orientResourceUnitName) {
      return Promise.resolve(null);
    }

    const unitName = child.orientResourceUnitName;
    const environment = child.orientSystemdEnvironment || this._systemdClientEnvironment();

    return new Promise(resolve => {
      let probe;
      try {
        probe = this.spawnProcess(this.systemctlPath, [
          '--user',
          'show',
          '--property=Result',
          '--property=ExecMainCode',
          '--property=ExecMainStatus',
          '--value',
          unitName
        ], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: environment
        });
      } catch {
        resolve(null);
        return;
      }

      let output = '';
      if (probe.stdout) {
        probe.stdout.on('data', chunk => {
          if (output.length < 4096) output += chunk.toString();
        });
      }
      probe.once('error', () => resolve(null));
      probe.once('close', code => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        const [result, mainCode, mainStatus] = output.trim().split(/\r?\n/);
        resolve({
          result: result || 'unknown',
          mainCode: mainCode || 'unknown',
          mainStatus: mainStatus || 'unknown'
        });
      });
    });
  }
}

module.exports = BubblewrapIsolator;
