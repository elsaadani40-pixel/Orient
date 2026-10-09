const BubblewrapIsolator = require('./bubblewrap-isolator');

function terminateProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    child.kill('SIGTERM');
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        child.kill('SIGKILL');
      }
    }
  }, 100);
}

class CommandRunner {
  constructor({ policy, isolator = new BubblewrapIsolator() }) {
    if (!policy) {
      throw new TypeError('policy is required');
    }

    this.policy = policy;
    if (!isolator || typeof isolator.spawn !== 'function') {
      throw new TypeError('isolator with spawn() is required');
    }
    this.isolator = isolator;
  }

  run(
    command,
    {
      cwd = '.',
      args = []
    } = {}
  ) {
    const executable =
      this.policy.assertCommand(command);

    const workingDirectory =
      this.policy.resolve(cwd);

    const outputLimit =
      this.policy.maxOutput;

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.isolator.spawn({
          executable,
          args: args.map(String),
          workspaceRoot: this.policy.allowedRoot,
          cwd: workingDirectory,
          environment: this.policy.environment,
          timeoutMs: this.policy.timeoutMs
        });
      } catch (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;

      const append = (current, chunk) => {
        const next =
          current + chunk.toString();

        if (next.length <= outputLimit) {
          return next;
        }

        truncated = true;
        return next.slice(
          0,
          outputLimit
        );
      };

      child.stdout.on(
        'data',
        chunk => {
          stdout = append(stdout, chunk);
        }
      );

      child.stderr.on(
        'data',
        chunk => {
          stderr = append(stderr, chunk);
        }
      );

      const timer = setTimeout(() => {
        terminateProcessTree(child);

        reject(
          new Error(
            `Command timed out after ${this.policy.timeoutMs}ms`
          )
        );
      }, this.policy.timeoutMs);

      child.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });

      child.on(
        'close',
        (code, signal) => {
          clearTimeout(timer);

          resolve({
            command: [
              executable,
              ...args.map(String)
            ].join(' '),
            cwd: workingDirectory,
            code,
            signal,
            stdout,
            stderr,
            truncated
          });
        }
      );
    });
  }
}

module.exports = CommandRunner;
