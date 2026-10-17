const AppError = require('../errors/AppError');
const { createToolExecutionAuthorizer } = require('./tool-execution-authorization');

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

class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.authorizationRequired = false;
    this.sealed = false;
    this.executionAuthorizer = createToolExecutionAuthorizer();
  }

  requireAuthorization() {
    this.authorizationRequired = true;
    return this;
  }

  register(tool) {
    if (this.sealed) {
      throw new AppError(
        'Tool registry is sealed and no longer accepts registrations',
        403,
        'TOOL_REGISTRY_SEALED'
      );
    }

    if (!tool || !tool.name || typeof tool.execute !== 'function') {
      throw new TypeError('Invalid tool');
    }

    if (this.tools.has(tool.name)) {
      throw new AppError(
        `الأداة "${tool.name}" مسجلة بالفعل`,
        409,
        'TOOL_ALREADY_REGISTERED'
      );
    }

    const effects = tool.effects ?? 'unknown';
    const idempotency = tool.idempotency ?? 'unknown';
    if (!TOOL_EFFECTS.has(effects)) {
      throw new TypeError(`Tool "${tool.name}" has invalid effects metadata`);
    }
    if (!TOOL_IDEMPOTENCY.has(idempotency)) {
      throw new TypeError(`Tool "${tool.name}" has invalid idempotency metadata`);
    }
    if (idempotency === 'reconcilable' && typeof tool.reconcile !== 'function') {
      throw new TypeError(`Tool "${tool.name}" declares reconcilable idempotency but provides no reconcile function`);
    }

    const execute = tool.execute.bind(tool);
    const registeredTool = Object.freeze({
      ...tool,
      execute: (input, context = {}) => {
        this.assertExecutionAuthorized(tool.name, context);
        return execute(input, context);
      },
      capabilities: Array.isArray(tool.capabilities)
        ? Object.freeze([...tool.capabilities])
        : Object.freeze([]),
      effects,
      idempotency,
      sandbox: tool.sandbox
        ? Object.freeze({
            required: tool.sandbox.required === true,
            profile: tool.sandbox.profile || null
          })
        : null
    });

    this.tools.set(tool.name, registeredTool);
    return registeredTool;
  }

  seal() {
    this.sealed = true;
    return this;
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  has(name) {
    return this.tools.has(name);
  }

  list() {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      capabilities: Array.isArray(tool.capabilities)
        ? [...tool.capabilities]
        : [],
      risk: tool.risk || null,
      effects: tool.effects || 'unknown',
      idempotency: tool.idempotency || 'unknown',
      sandbox: tool.sandbox
        ? {
            required: tool.sandbox.required === true,
            profile: tool.sandbox.profile || null
          }
        : null
    }));
  }

  async execute(name, input, context = {}) {
    const tool = this.get(name);

    if (!tool) {
      throw new AppError(
        `الأداة "${name}" غير موجودة`,
        404,
        'TOOL_NOT_FOUND'
      );
    }

    this.assertExecutionAuthorized(name, context);
    return tool.execute(input, context);
  }

  assertExecutionAuthorized(name, context = {}) {
    if (this.authorizationRequired && !this.executionAuthorizer.isAuthorized(context, {
      tool: name,
      agentId: context.agentId,
      executionId: context.executionId,
      step: context.step,
      planRevision: Number(context.plan?.revision || context.planRevision || 1)
    })) {
      throw new AppError(
        `الأداة "${name}" تتطلب تفويضًا من مسار التنفيذ المصرح به`,
        403,
        'TOOL_EXECUTION_AUTHORIZATION_REQUIRED'
      );
    }
  }

  authorizeExecutionContext(context, decision, binding = {}) {
    return this.executionAuthorizer.authorizeContext(context, decision, binding);
  }
}

module.exports = ToolRegistry;
