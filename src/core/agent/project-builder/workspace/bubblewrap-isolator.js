'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  normalizeResourceLimits,
  buildSystemdRunArgs
} = require('./resource-limit-policy');
const { isUnsandboxedExecutionEnabled } = require('./unsandboxed-execution-policy');

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

const RESOURCE_LIMITS_VERIFIED_MARKER = '__ORIENT_RESOURCE_LIMITS_VERIFIED__';

function noSandboxError() {
  const error = new Error(
    'OS-isolated command execution is supported only on Linux; refusing unsafe fallback'
  );
  error.code = 'ORIENT_E_NO_SANDBOX';
  return error;
}
const SYSTEMD_LIMIT_GATE_SCRIPT = String.raw`
'use strict';
const { spawnSync } = require('node:child_process');
const [unitName, systemctlPath, limitsJson, timeoutMs, clientEnvironmentJson, executable, ...args] = process.argv.slice(1);
const clientEnvironment = { ...process.env, ...JSON.parse(clientEnvironmentJson) };
const l = JSON.parse(limitsJson);
const deadline = Date.now() + 1500;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const show = () => {
 const r = spawnSync(systemctlPath, ['--user','show','--property=ActiveState','--property=MemoryMax','--property=CPUQuotaPerSecUSec','--property=TasksMax','--property=LimitNOFILE','--property=LimitFSIZE','--property=RuntimeMaxUSec','--property=LimitCPU','--property=LimitCPUSoft','--property=MemorySwapMax',unitName], {encoding:'utf8',env:clientEnvironment,timeout:500});
 if (r.status !== 0 || !r.stdout) return null;
 return Object.fromEntries(r.stdout.split(/\r?\n/).flatMap(s => { const i=s.indexOf('='); return i>0 ? [[s.slice(0,i),s.slice(i+1)]] : []; }));
};
const one = (v, xs) => xs.includes(v);
const durationMatches = (value, seconds) => {
 const text = String(value || '');
 const re = /(\d+)(us|µs|ms|s|min|h|d|w)/g;
 let total = 0, end = 0, match;
 const factor = { us: 1, 'µs': 1, ms: 1000, s: 1000000, min: 60000000, h: 3600000000, d: 86400000000, w: 604800000000 };
 while ((match = re.exec(text)) !== null) {
   if (text.slice(end, match.index).trim()) return false;
   total += Number(match[1]) * factor[match[2]];
   end = re.lastIndex;
 }
 return end > 0 && !text.slice(end).trim() && total === seconds * 1000000;
};
const paired = (v, n) => one(v,[String(n),String(n)+':'+String(n)]);
const cpu = (v, soft, hard) => one(v,[String(hard),String(hard)+'s',String(hard*1000000),String(hard*1000000)+'us',String(soft)+'s:'+String(hard)+'s',String(soft)+':'+String(hard)]);
const quota=l.cpuQuotaPercent*10000;
const seconds=Math.max(1,Math.ceil(Number(timeoutMs)/1000));
let ok=false;
while(Date.now()<=deadline){
 const p=show();
 if(p && p.ActiveState==='active' && p.MemoryMax===String(l.memoryMaxBytes) &&
 one(p.CPUQuotaPerSecUSec,[String(quota),String(quota/1000000)+'s',String(quota/1000)+'ms',String(quota)+'us']) &&
 p.TasksMax===String(l.maxProcesses) && paired(p.LimitNOFILE,Math.max(l.maxOpenFiles,256)) &&
 paired(p.LimitFSIZE,l.maxFileSizeBytes) &&
 durationMatches(p.RuntimeMaxUSec, seconds) &&
 cpu(p.LimitCPU,l.maxCpuTimeSeconds,l.maxCpuTimeSeconds+1) &&
 one(p.LimitCPUSoft,[String(l.maxCpuTimeSeconds),String(l.maxCpuTimeSeconds)+'s',String(l.maxCpuTimeSeconds*1000000),String(l.maxCpuTimeSeconds*1000000)+'us']) &&
 p.MemorySwapMax==='0'){ok=true;break;}
 sleep(25);
}
if(!ok){process.stderr.write('ORIENT resource quota preflight failed; refusing to start sandbox\\n');process.exit(125);}
process.stderr.write('__ORIENT_RESOURCE_LIMITS_VERIFIED__\n');
const result=spawnSync('prlimit',['--nofile='+l.maxOpenFiles+':'+l.maxOpenFiles,executable,...args],{stdio:'inherit',env:clientEnvironment});
if(result.error){process.stderr.write('ORIENT sandbox launch failed: '+result.error.message+'\n');process.exit(126);}
process.exit(Number.isInteger(result.status)?result.status:1);
`;

/**
 * OS isolation for untrusted Project Builder commands.
 *
 * Linux always requires Bubblewrap plus a transient systemd cgroup service.
 * macOS and Windows remain fail-closed by default; direct execution is allowed
 * only through ORIENT_ALLOW_UNSANDBOXED=1 and is explicitly marked as lacking
 * OS isolation and OS-enforced resource limits. There is no silent fallback.
 */
class BubblewrapIsolator {
  constructor({
    spawnProcess = spawn,
    platform = process.platform,
    systemdRunPath = process.env.ORIENT_SYSTEMD_RUN_PATH || 'systemd-run',
    systemctlPath = process.env.ORIENT_SYSTEMCTL_PATH || 'systemctl',
    readFileSync = fs.readFileSync,
    env = process.env
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.systemdRunPath = systemdRunPath;
    this.systemctlPath = systemctlPath;
    this.readFileSync = readFileSync;
    this.environment = env;
    this.allowUnsandboxed = isUnsandboxedExecutionEnabled({ platform, env });
  }

  _resolveWorkspaceDirectories(workspaceRoot, cwd) {
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
    return { root, workingDirectory, relativeCwd };
  }

  _spawnUnsandboxed({ executable, args = [], workspaceRoot, cwd, environment = {} }) {
    const { workingDirectory } = this._resolveWorkspaceDirectories(workspaceRoot, cwd);
    for (const [key] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid sandbox environment variable name: ${key}`);
      }
    }

    // Do not inherit the host process environment wholesale. Only PATH and the
    // Windows loader roots are required by the direct-execution compatibility path.
    const childEnvironment = {
      PATH: this.environment?.PATH || this.environment?.Path || ''
    };
    if (this.platform === 'win32') {
      for (const key of ['SystemRoot', 'WINDIR']) {
        if (typeof this.environment?.[key] === 'string') childEnvironment[key] = this.environment[key];
      }
    }
    Object.assign(childEnvironment, environment);

    const child = this.spawnProcess(executable, args.map(String), {
      cwd: workingDirectory,
      shell: false,
      windowsHide: true,
      detached: this.platform !== 'win32',
      env: childEnvironment
    });
    child.orientUnsandboxed = true;
    child.orientResourceLimitsVerified = false;
    child.orientResourceLimitMode = 'unsandboxed-opt-in';
    return child;
  }

  buildArgs({ executable, args = [], workspaceRoot, cwd, environment = {} }) {
    if (this.platform !== 'linux') {
      throw noSandboxError();
    }

    const { root, workingDirectory, relativeCwd } =
      this._resolveWorkspaceDirectories(workspaceRoot, cwd);

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
      cgroupMembership = this.readFileSync('/proc/self/cgroup', 'utf8');
      controllers = this.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8')
        .trim()
        .split(/\s+/)
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
      if (this.allowUnsandboxed) {
        return this._spawnUnsandboxed({
          executable, args, workspaceRoot, cwd, environment
        });
      }
      throw noSandboxError();
    }

    this._assertCgroupV2();

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
    // Keep the trusted preflight helper able to open its systemd bus sockets;
    // apply the requested per-process NOFILE limit to bubblewrap and its child
    // through prlimit only after the cgroup quota preflight succeeds.
    const supervisorLimits = { ...limits, maxOpenFiles: Math.max(limits.maxOpenFiles, 256) };
    const supervisorArgs = buildSystemdRunArgs({
      unitName,
      timeoutMs,
      limits: supervisorLimits,
      executable: process.execPath,
      args: ['-e', SYSTEMD_LIMIT_GATE_SCRIPT, unitName, this.systemctlPath, JSON.stringify(limits), String(timeoutMs), JSON.stringify(this._systemdClientEnvironment()), bwrap, ...sandboxArgs]
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
    child.orientResourceLimitsGateMarker = RESOURCE_LIMITS_VERIFIED_MARKER;
    child.orientResourceLimits = limits;
    child.orientSystemdEnvironment = this._systemdClientEnvironment();
    child.orientInitialInspection = this.inspect(child, { waitMs: 1500, waitForActive: true });
    return child;
  }

  terminate(child) {
    if (child?.orientUnsandboxed === true) {
      if (this.platform === 'win32') {
        try { child.kill('SIGTERM'); } catch {}
        return new Promise(resolve => {
          let killer;
          try {
            killer = this.spawnProcess('taskkill.exe', [
              '/PID', String(child.pid), '/T', '/F'
            ], {
              shell: false,
              windowsHide: true,
              stdio: 'ignore',
              env: {
                PATH: this.environment?.PATH || this.environment?.Path || '',
                ...(this.environment?.SystemRoot ? { SystemRoot: this.environment.SystemRoot } : {})
              }
            });
          } catch {
            resolve(false);
            return;
          }
          killer.once('error', () => resolve(false));
          killer.once('close', code => resolve(code === 0));
        });
      }

      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code === 'ESRCH') {
          try { child.kill('SIGTERM'); } catch {}
        } else {
          try { child.kill('SIGTERM'); } catch {}
        }
      }
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 100);
      timer.unref?.();
      return Promise.resolve(true);
    }

    if (!child || !child.orientResourceUnitName) return Promise.resolve(false);

    const unitName = child.orientResourceUnitName;
    const environment = child.orientSystemdEnvironment || this._systemdClientEnvironment();

    try {
      child.kill('SIGTERM');
    } catch {
      // The systemd unit stop remains authoritative for descendants.
    }

    const runSystemctl = args => new Promise(resolve => {
      let command;
      try {
        command = this.spawnProcess(this.systemctlPath, args, {
          shell: false,
          windowsHide: true,
          stdio: args.includes('--value') ? ['ignore', 'pipe', 'ignore'] : 'ignore',
          env: environment
        });
      } catch {
        resolve({ ok: false, output: '' });
        return;
      }

      let done = false;
      let output = '';
      let timer;
      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      if (command.stdout) {
        command.stdout.on('data', chunk => {
          if (output.length < 4096) output += chunk.toString();
        });
      }
      timer = setTimeout(() => {
        try { command.kill('SIGKILL'); } catch {}
        finish({ ok: false, output });
      }, 1000);
      command.once('error', () => finish({ ok: false, output }));
      command.once('close', code => finish({ ok: code === 0, output }));
    });

    return (async () => {
      // Attempt both kill and stop: a failed kill must not prevent the authoritative stop.
      const killResult = await runSystemctl([
        '--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unitName
      ]);
      const stopResult = await runSystemctl(['--user', 'stop', unitName]);

      // A successful "stop" command is not proof that the unit is no longer active.
      const status = await runSystemctl([
        '--user', 'show', '--property=ActiveState', '--value', unitName
      ]);
      const inactive = status.ok && ['inactive', 'failed'].includes(status.output.trim());
      if (!inactive) return false;

      const resetResult = await runSystemctl(['--user', 'reset-failed', unitName]);
      return killResult.ok && stopResult.ok && resetResult.ok;
    })().catch(() => false);
  }
  cleanup(child) {
    if (child?.orientUnsandboxed === true) return Promise.resolve(true);
    if (!child || !child.orientResourceUnitName) return Promise.resolve(false);

    const unitName = child.orientResourceUnitName;
    const environment = child.orientSystemdEnvironment || this._systemdClientEnvironment();
    const runSystemctl = (args, captureOutput = false) => new Promise(resolve => {
      let command;
      try {
        command = this.spawnProcess(this.systemctlPath, args, {
          shell: false,
          windowsHide: true,
          stdio: captureOutput ? ['ignore', 'pipe', 'ignore'] : 'ignore',
          env: environment
        });
      } catch {
        resolve({ ok: false, output: '' });
        return;
      }

      let done = false;
      let output = '';
      let timer;
      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      if (command.stdout) {
        command.stdout.on('data', chunk => {
          if (output.length < 4096) output += chunk.toString();
        });
      }
      timer = setTimeout(() => {
        try { command.kill('SIGKILL'); } catch {}
        finish({ ok: false, output });
      }, 1000);
      command.once('error', () => finish({ ok: false, output }));
      command.once('close', code => finish({ ok: code === 0, output }));
    });

    return (async () => {
      const loadState = async () => {
        const status = await runSystemctl([
          '--user', 'show', '--property=LoadState', '--value', unitName
        ], true);
        return status.ok ? status.output.trim() : null;
      };

      // Successful transient units may already have been unloaded. Avoid
      // resetting a missing unit and verify the actual manager state either way.
      let state = await loadState();
      if (state === 'not-found') return true;
      if (!state) return false;

      const reset = await runSystemctl(['--user', 'reset-failed', unitName]);
      if (!reset.ok) return false;

      // reset-failed is only a request; verify the unit has actually been unloaded.
      // Do not use systemd-run --collect because CommandRunner needs terminal
      // cgroup status first to classify OOM/timeout/resource-limit failures.
      const deadline = Date.now() + 1000;
      while (Date.now() <= deadline) {
        state = await loadState();
        if (state === 'not-found') return true;
        if (!state) return false;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return false;
    })().catch(() => false);
  }

  inspect(child, { waitMs = 0, waitForActive = false } = {}) {
    if (!child || !child.orientResourceUnitName) return Promise.resolve(null);

    const unitName = child.orientResourceUnitName;
    const environment = child.orientSystemdEnvironment || this._systemdClientEnvironment();
    const deadline = Date.now() + Math.max(0, waitMs);

    return new Promise(resolve => {
      const retryOrResolve = value => {
        // The unit can briefly exist in an inactive/default state before systemd
        // applies the transient service properties. Initial snapshots must wait
        // for the active unit; terminal inspections intentionally accept inactive.
        if (value !== null && (!waitForActive || value.activeState === 'active')) {
          resolve(value);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(probeUnit, 25);
      };

      const probeUnit = () => {
        let probe;
        try {
          probe = this.spawnProcess(this.systemctlPath, [
            '--user',
            'show',
            '--property=Result',
            '--property=ActiveState',
            '--property=ExecMainCode',
            '--property=ExecMainStatus',
            '--property=MemoryMax',
            '--property=CPUQuotaPerSecUSec',
            '--property=TasksMax',
            '--property=LimitNOFILE',
            '--property=LimitFSIZE',
            '--property=RuntimeMaxUSec',
            '--property=LimitCPU',
            '--property=LimitCPUSoft',
            '--property=MemorySwapMax',
            unitName
          ], {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: environment
          });
        } catch {
          retryOrResolve(null);
          return;
        }

        let output = '';
        let finished = false;
        let probeTimer;
        const finish = value => {
          if (finished) return;
          finished = true;
          clearTimeout(probeTimer);
          retryOrResolve(value);
        };
        probeTimer = setTimeout(() => {
          try { probe.kill('SIGKILL'); } catch {}
          finish(null);
        }, 500);

        if (probe.stdout) {
          probe.stdout.on('data', chunk => {
            if (output.length < 4096) output += chunk.toString();
          });
        }
        probe.once('error', () => finish(null));
        probe.once('close', code => {
          if (code !== 0 || !output.trim()) {
            finish(null);
            return;
          }

          const properties = {};
          for (const line of output.split(/\r?\n/)) {
            const separator = line.indexOf('=');
            if (separator < 1) continue;
            properties[line.slice(0, separator)] = line.slice(separator + 1);
          }

          const activeState = properties.ActiveState || 'unknown';
          const result = properties.Result || (activeState === 'active' ? 'running' : 'unknown');
          finish({
            result,
            activeState,
            mainCode: properties.ExecMainCode || 'unknown',
            mainStatus: properties.ExecMainStatus || 'unknown',
            enforcedProperties: {
              memoryMax: properties.MemoryMax || 'unknown',
              cpuQuotaPerSecUSec: properties.CPUQuotaPerSecUSec || 'unknown',
              tasksMax: properties.TasksMax || 'unknown',
              limitNoFile: properties.LimitNOFILE || 'unknown',
              limitFSize: properties.LimitFSIZE || 'unknown',
              runtimeMaxUSec: properties.RuntimeMaxUSec || 'unknown',
              limitCPU: properties.LimitCPU || 'unknown',
              limitCPUSoft: properties.LimitCPUSoft || 'unknown',
              memorySwapMax: properties.MemorySwapMax || 'unknown'
            }
          });
        });
      };

      probeUnit();
    });
  }
}

module.exports = BubblewrapIsolator;
