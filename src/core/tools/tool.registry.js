const AppError = require('../errors/AppError');
const { createToolExecutionAuthorizer } = require('./tool-execution-authorization');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.authorizationRequired = false;
    this.executionAuthorizer = createToolExecutionAuthorizer();
  }

  requireAuthorization() {
    this.authorizationRequired = true;
    return this;
  }

  register(tool) {
    if (!tool || !tool.name || typeof tool.execute !== 'function') {
      throw new TypeError('Invalid tool');
    }

    if (this.tools.has(tool.name)) {
      throw new AppError(
        `الأداة "${tool.name}" مسجلة بالفعل`,
        500,
        'TOOL_ALREADY_REGISTERED'
      );
    }

    const registeredTool = Object.freeze({
      ...tool,
      capabilities: Object.freeze(Array.isArray(tool.capabilities) ? [...tool.capabilities] : []),
      sandbox: tool.sandbox && typeof tool.sandbox === 'object'
        ? Object.freeze({
            ...tool.sandbox,
            profile: tool.sandbox.profile && typeof tool.sandbox.profile === 'object'
              ? Object.freeze({ ...tool.sandbox.profile })
              : tool.sandbox.profile
          })
        : tool.sandbox
    });

    this.tools.set(tool.name, registeredTool);
    return tool;
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

    return tool.execute(input, context);
  }

  authorizeExecutionContext(context, decision, binding = {}) {
    return this.executionAuthorizer.authorizeContext(context, decision, binding);
  }
}

module.exports = ToolRegistry;
