class CommandVerification {
  constructor({ commandRunner }) {
    if (!commandRunner) {
      throw new TypeError(
        'commandRunner is required'
      );
    }

    this.commandRunner = commandRunner;
  }

  createCheck({
    id,
    executable,
    args = []
  }) {
    if (!id || typeof id !== 'string') {
      throw new TypeError(
        'id is required'
      );
    }

    if (
      !executable ||
      typeof executable !== 'string'
    ) {
      throw new TypeError(
        'executable is required'
      );
    }

    return {
      id,
      run: async () => {
        const result =
          await this.commandRunner.run(
            executable,
            { args }
          );

        return {
          passed:
            result.code === 0,
          exitCode:
            result.code,
          stdout:
            result.stdout,
          stderr:
            result.stderr
        };
      }
    };
  }
}

module.exports = CommandVerification;
