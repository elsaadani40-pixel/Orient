const crypto = require('crypto');

const NODE_STATUS = require('./node.status');

class ExecutionNode {
  constructor({
    id = crypto.randomUUID(),
    type = 'tool',
    tool,
    input = null,
    dependencies = []
  } = {}) {
    if (!tool) {
      throw new Error('tool is required');
    }

    this.id = id;
    this.type = type;
    this.tool = tool;
    this.input = input;
    this.dependencies = [...dependencies];
    this.status = NODE_STATUS.PENDING;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      tool: this.tool,
      input: this.input,
      dependencies: this.dependencies,
      status: this.status
    };
  }
}

module.exports = ExecutionNode;
