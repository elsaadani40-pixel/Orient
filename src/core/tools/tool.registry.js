const AppError = require('../errors/AppError');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
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

    this.tools.set(tool.name, tool);
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
      description: tool.description
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

    return tool.execute(input, context);
  }
}

module.exports = ToolRegistry;
