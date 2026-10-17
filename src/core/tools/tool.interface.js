const { createSandboxPolicy } = require('../security/sandbox/sandbox-policy');

const TOOL_EFFECTS = new Set([
  'read_only',
  'local_mutation',
  'external_side_effect',
  'mixed',
  'unknown'
]);

const TOOL_IDEMPOTENCY = new Set([
  'idempotent',
  'keyed',
  'reconcilable',
  'non_idempotent',
  'unknown'
]);

class ToolInterface {
  constructor({
    name,
    description,
    execute,
    retryable = false,
    capabilities = [],
    risk = null,
    sandbox = null,
    reconcile = null,
    effects = 'unknown',
    idempotency = 'unknown'
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

    if (reconcile !== null && typeof reconcile !== 'function') {
      throw new TypeError(
        `Tool "${name}" reconcile must be a function when provided`
      );
    }

    if (!Array.isArray(capabilities)) {
      throw new TypeError(
        `Tool "${name}" capabilities must be an array`
      );
    }

    if (!TOOL_EFFECTS.has(effects)) {
      throw new TypeError(
        `Tool "${name}" effects must be one of: ${[...TOOL_EFFECTS].join(', ')}`
      );
    }

    if (!TOOL_IDEMPOTENCY.has(idempotency)) {
      throw new TypeError(
        `Tool "${name}" idempotency must be one of: ${[...TOOL_IDEMPOTENCY].join(', ')}`
      );
    }

    if (idempotency === 'reconcilable' && typeof reconcile !== 'function') {
      throw new TypeError(
        `Tool "${name}" declares reconcilable idempotency but provides no reconcile function`
      );
    }

    this.name = name;
    this.description =
      description || '';

    this.execute = execute;
    this.reconcile = reconcile;

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

    this.effects = effects;
    this.idempotency = idempotency;

    this.sandbox =
      sandbox && typeof sandbox === 'object'
        ? Object.freeze({
            required: sandbox.required === true,
            profile: sandbox.profile && typeof sandbox.profile === 'object' ? createSandboxPolicy(sandbox.profile) : sandbox.profile || null
          })
        : null;

    Object.freeze(this);
  }
}

module.exports = ToolInterface;
