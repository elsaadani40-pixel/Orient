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
          if (typeof this.isolator.terminate === 'function') {
            Promise.resolve(this.isolator.terminate(child)).catch(() => {});
          } else {
            terminateProcessTree(child);
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

        const inspect = typeof this.isolator.inspect === 'function'
          ? this.isolator.inspect(child)
          : Promise.resolve(null);

        Promise.resolve(inspect).catch(() => null).then(executionStatus => {
          if (settled) return;
          settled = true;

          let failureCode = null;
          if (executionStatus?.result === 'oom-kill') {
            failureCode = 'MEMORY_LIMIT_EXCEEDED';
          } else if (executionStatus?.result === 'timeout') {
            failureCode = 'COMMAND_TIMEOUT';
          } else if (executionStatus?.result === 'signal' && Number(executionStatus.mainStatus) === 24) {
            failureCode = 'CPU_LIMIT_EXCEEDED';
          } else if (executionStatus?.result === 'resources') {
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
            resourceLimitMode: 'systemd-user-service-cgroup-v2',
            resourceLimitStatus: executionStatus,
            failureCode
          });
        });
      });
    });
  }
}

module.exports = CommandRunner;
