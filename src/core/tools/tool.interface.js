class ToolInterface {
  constructor({
    name,
    description,
    execute,
    retryable = false
  }) {
    if (!name || typeof name !== 'string') {
      throw new TypeError(
        'Tool name is required'
      );
    }

    if (typeof execute !== 'function') {
      throw new TypeError(
        `Tool "${name}" must provide an execute function`
      );
    }

    this.name = name;
    this.description =
      description || '';

    this.execute = execute;

    this.retryable =
      retryable === true;
  }
}

module.exports = ToolInterface;
