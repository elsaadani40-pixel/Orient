class ToolInterface {
  constructor({
    name,
    description,
    execute,
    retryable = false,
    capabilities = [],
    risk = null,
    sandbox = null
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

    if (!Array.isArray(capabilities)) {
      throw new TypeError(
        `Tool "${name}" capabilities must be an array`
      );
    }

    this.name = name;
    this.description =
      description || '';

    this.execute = execute;

    this.retryable =
      retryable === true;

    this.capabilities = Object.freeze(
      [...new Set(capabilities.filter(
        capability =>
          typeof capability === 'string' &&
          capability.trim()
      ))]
    );

    this.risk =
      typeof risk === 'string' && risk.trim()
        ? risk.trim()
        : null;

    this.sandbox =
      sandbox && typeof sandbox === 'object'
        ? Object.freeze({
            required: sandbox.required === true,
            profile: sandbox.profile || null
          })
        : null;
  }
}

module.exports = ToolInterface;
