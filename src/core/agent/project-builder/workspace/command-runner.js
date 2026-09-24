const { spawn } = require('child_process');

class CommandRunner {
  constructor({ policy }) {
    if (!policy) {
      throw new TypeError('policy is required');
    }

    this.policy = policy;
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
      const child = spawn(
        executable,
        args.map(String),
        {
          cwd: workingDirectory,
          shell: false,
          windowsHide: true
        }
      );

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
        child.kill('SIGTERM');

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
