'use strict';

const BubblewrapIsolator = require('./bubblewrap-isolator');

function terminateProcessTree(child) {
  if (!child || !child.pid) return;

  if (process.platform === 'win32') {
    child.kill('SIGTERM');
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill('SIGTERM');
  }

  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }, 100);
}

function commandError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'CommandExecutionError';
  error.code = code;
  error.details = details;
  return error;
}

class CommandRunner {
  constructor({ policy, isolator = new BubblewrapIsolator() }) {
    if (!policy) throw new TypeError('policy is required');
    this.policy = policy;
    if (!isolator || typeof isolator.spawn !== 'function') {
      throw new TypeError('isolator with spawn() is required');
    }
    this.isolator = isolator;
  }

  run(command, { cwd = '.', args = [] } = {}) {
    const executable = this.policy.assertCommand(command);
    const workingDirectory = this.policy.resolve(cwd);
    const outputLimit = Math.max(1, Math.floor(
      this.policy.resourceLimits?.maxOutputBytes || this.policy.maxOutput || 20000
    ));

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.isolator.spawn({
          executable,
          args: args.map(String),
          workspaceRoot: this.policy.allowedRoot,
          cwd: workingDirectory,
          environment: this.policy.environment,
          timeoutMs: this.policy.timeoutMs,
          resourceLimits: this.policy.resourceLimits
        });
      } catch (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';
      let totalOutputBytes = 0;
      let settled = false;
      let timer;

      const finishReject = (error, terminate = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (terminate) {
          try {
            if (typeof this.isolator.terminate === 'function') {
              Promise.resolve().then(() => this.isolator.terminate(child)).catch(() => {});
            } else {
              terminateProcessTree(child);
            }
          } catch {
            // The rejection remains authoritative; the OS runtime cap is the fallback kill boundary.
          }
        }
        reject(error);
      };

      const append = (current, chunk) => {
        const text = chunk.toString();
        totalOutputBytes += chunk.length;
        return current.length >= outputLimit
          ? current
          : (current + text).slice(0, outputLimit);
      };

      const onOutput = (stream, chunk) => {
        if (settled) return;
        if (stream === 'stdout') stdout = append(stdout, chunk);
        else stderr = append(stderr, chunk);

        if (totalOutputBytes > outputLimit) {
          finishReject(commandError(
            'OUTPUT_LIMIT_EXCEEDED',
            `Command output exceeded the ${outputLimit}-byte limit`,
            { outputLimitBytes: outputLimit, observedOutputBytes: totalOutputBytes }
          ));
        }
      };

      child.stdout?.on('data', chunk => onOutput('stdout', chunk));
      child.stderr?.on('data', chunk => onOutput('stderr', chunk));

      timer = setTimeout(() => {
        finishReject(commandError(
          'COMMAND_TIMEOUT',
          `Command timed out after ${this.policy.timeoutMs}ms`,
          { timeoutMs: this.policy.timeoutMs }
        ));
      }, this.policy.timeoutMs);

      child.on('error', error => {
        finishReject(commandError(
          'RESOURCE_LIMITS_UNAVAILABLE',
          'The isolated resource supervisor could not be started; command execution was denied',
          { causeCode: error.code || 'UNKNOWN', message: error.message }
        ), false);
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        clearTimeout(timer);

        const initialInspection = child.orientInitialInspection || Promise.resolve(null);
        // Capture the terminal systemd result before cleanup can reset failure state.
        // Successful exits need inspection too; the initial snapshot may have been "running".
        const finalInspection = typeof this.isolator.inspect === 'function'
          ? Promise.resolve().then(() => this.isolator.inspect(child)).catch(() => null)
          : Promise.resolve(null);

        Promise.all([
          Promise.resolve(initialInspection).catch(() => null),
          finalInspection
        ]).then(async ([initialStatus, finalStatus]) => {
          if (settled) return;

          const executionStatus = finalStatus
            ? {
                ...initialStatus,
                ...finalStatus,
                enforcedProperties: initialStatus?.enforcedProperties || finalStatus.enforcedProperties
              }
            : initialStatus;

          if (typeof this.isolator.cleanup === 'function') {
            await Promise.resolve().then(() => this.isolator.cleanup(child)).catch(() => false);
          }
          if (settled) return;
          settled = true;

          let failureCode = null;
          const lowerStderr = stderr.toLowerCase();
          const expectedLimits = this.policy.resourceLimits;
          const observedLimits = executionStatus?.enforcedProperties;
          const isSystemdUnit = Boolean(child.orientResourceUnitName);
          const expectedRuntime = String(Math.max(1, Math.ceil(this.policy.timeoutMs / 1000))) + 's';
          const expectedCpuQuota = expectedLimits.cpuQuotaPercent * 10000;
          const observedCpuQuota = observedLimits?.cpuQuotaPerSecUSec;
          const cpuQuotaMatches = observedCpuQuota === String(expectedCpuQuota) ||
            observedCpuQuota === String(expectedCpuQuota / 1000000) + 's' ||
            observedCpuQuota === String(expectedCpuQuota / 1000) + 'ms' ||
            observedCpuQuota === String(expectedCpuQuota) + 'us';
          const limitsVerified = isSystemdUnit && Boolean(
            initialStatus?.activeState === 'active' &&
            observedLimits &&
            observedLimits.memoryMax === String(expectedLimits.memoryMaxBytes) &&
            cpuQuotaMatches &&
            observedLimits.tasksMax === String(expectedLimits.maxProcesses) &&
            observedLimits.limitNoFile === String(expectedLimits.maxOpenFiles) &&
            observedLimits.limitFSize === String(expectedLimits.maxFileSizeBytes) &&
            observedLimits.runtimeMaxUSec === expectedRuntime &&
            observedLimits.limitCPU === String(expectedLimits.maxCpuTimeSeconds + 1) &&
            observedLimits.limitCPUSoft === String(expectedLimits.maxCpuTimeSeconds) &&
            observedLimits.memorySwapMax === '0'
          );
          const systemdUnavailable = /failed to connect to bus|no medium found|failed to start transient|failed to create transient|unknown assignment|not supported|failed to set unit properties/.test(lowerStderr);

          if (executionStatus?.result === 'oom-kill' || /out of memory|cannot allocate memory/.test(lowerStderr)) {
            failureCode = 'MEMORY_LIMIT_EXCEEDED';
          } else if (executionStatus?.result === 'timeout') {
            failureCode = 'COMMAND_TIMEOUT';
          } else if (
            [24, 152].includes(Number(executionStatus?.mainStatus)) ||
            signal === 'SIGXCPU'
          ) {
            failureCode = 'CPU_LIMIT_EXCEEDED';
          } else if (signal === 'SIGXFSZ' || [25, 153].includes(Number(executionStatus?.mainStatus)) || /file size limit exceeded|efbig|file too large/.test(lowerStderr)) {
            failureCode = 'FILE_SIZE_LIMIT_EXCEEDED';
          } else if (/too many open files|emfile/.test(lowerStderr)) {
            failureCode = 'OPEN_FILE_LIMIT_EXCEEDED';
          } else if (/process_limit_eagain|resource temporarily unavailable|fork:.*eagain|pthread_create.*eagain/.test(lowerStderr)) {
            failureCode = 'PROCESS_LIMIT_EXCEEDED';
          } else if (systemdUnavailable || executionStatus?.result === 'resources') {
            failureCode = 'RESOURCE_LIMITS_UNAVAILABLE';
          } else if (signal === 'SIGKILL' || Number(code) === 137) {
            failureCode = 'RESOURCE_LIMIT_EXCEEDED_OR_KILLED';
          } else if (Number(code) !== 0) {
            failureCode = 'COMMAND_FAILED';
          }

          if (isSystemdUnit && !limitsVerified) {
            failureCode = 'RESOURCE_LIMITS_UNAVAILABLE';
          }

          resolve({
            command: [executable, ...args.map(String)].join(' '),
            cwd: workingDirectory,
            code,
            signal,
            stdout,
            stderr,
            truncated: false,
            resourceLimitMode: child.orientResourceUnitName ? 'systemd-user-service-cgroup-v2' : 'custom-isolator',
            resourceLimitStatus: executionStatus,
            resourceLimitsVerified: limitsVerified,
            failureCode
          });
        });
      });
    });
  }
}

module.exports = CommandRunner;
